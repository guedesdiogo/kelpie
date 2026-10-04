import {
  ACCESS_SOURCE,
  ADMIN_AGENT_ID,
  type Admission,
  type ChannelIdentity,
  type OwnerResult,
} from "@kelpie/access";
import type { Actor, CommandResult, ConfigCommands } from "@kelpie/config";
import type { Verification } from "./access-jwt.ts";

/** What the API needs from outside, so tests can replace it. */
export interface AdminDeps {
  /** Verifies the request's Cloudflare Access JWT. */
  authenticate(request: Request): Promise<Verification>;
  directory: {
    admit(identity: ChannelIdentity, agentId: string): Promise<Admission>;
    ownerExists(): Promise<boolean>;
    bootstrapOwner(userId: string, accessSub: string): Promise<OwnerResult>;
  };
  commands: ConfigCommands;
  /** The first-run token set at deploy (ADR-0013): `<expiry in epoch seconds>.<random>`. */
  bootstrapToken: string | undefined;
  now(): number;
  newUserId(): string;
}

/** Command inputs are small; the largest is a system prompt of at most 20,000 characters. */
const MAX_BODY_BYTES = 64 * 1024;

type Failure = Extract<CommandResult<unknown>, { ok: false }>["reason"];

const STATUS: Record<Failure, number> = {
  forbidden: 403,
  invalid_input: 400,
  invalid_identity: 400,
  unknown_agent: 404,
  unknown_user: 404,
  unknown_identity: 404,
  identity_taken: 409,
};

type Command = (
  commands: ConfigCommands,
  actor: Actor,
  input: unknown,
) => Promise<CommandResult<unknown>>;

/** One endpoint per configuration command (ADR-0013): `POST /commands/<name>` with its input. */
const COMMANDS: Record<string, Command> = {
  listAgents: (commands, actor) => commands.listAgents(actor),
  createAgent: (commands, actor, input) => commands.createAgent(actor, input),
  renameAgent: (commands, actor, input) => commands.renameAgent(actor, input),
  getAgent: (commands, actor, input) => commands.getAgent(actor, input),
  configureAgent: (commands, actor, input) => commands.configureAgent(actor, input),
  listIdentities: (commands, actor) => commands.listIdentities(actor),
  addIdentity: (commands, actor, input) => commands.addIdentity(actor, input),
  enableIdentity: (commands, actor, input) => commands.enableIdentity(actor, input),
  disableIdentity: (commands, actor, input) => commands.disableIdentity(actor, input),
};

/**
 * The owner's admin API (Story 3.10). Cloudflare Access sits in front of it; every request still
 * verifies the Access JWT, and the `Directory` decides who the caller is.
 */
export async function handle(request: Request, deps: AdminDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  const command = pathname.startsWith("/commands/") ? pathname.slice("/commands/".length) : null;
  if (request.method !== "POST" || (pathname !== "/bootstrap" && !command)) {
    return refuse(404, "not_found");
  }
  if (command !== null && !Object.hasOwn(COMMANDS, command)) return refuse(404, "not_found");

  let identity: Verification;
  try {
    identity = await deps.authenticate(request);
  } catch (error) {
    console.error("admin-api: Access keys unavailable", errorName(error));
    return refuse(503, "unavailable");
  }
  if (!identity.ok) {
    console.warn("admin-api: request refused", { reason: identity.reason });
    return refuse(401, "unauthenticated");
  }

  const body = await readJson(request);
  if (!body.ok) return refuse(body.status, body.reason);

  if (pathname === "/bootstrap") return bootstrap(identity.sub, body.value, deps);

  const admission = await deps.directory.admit(
    { channel: ACCESS_SOURCE, channelUserId: identity.sub },
    ADMIN_AGENT_ID,
  );
  if (!admission.admitted) {
    return (await deps.directory.ownerExists())
      ? refuse(403, "forbidden")
      : refuse(403, "no_owner");
  }
  const actor: Actor = { userId: admission.userId, role: admission.role, via: "admin-api" };
  // `command` is a key of COMMANDS: checked above.
  const result = await (COMMANDS[command as string] as Command)(deps.commands, actor, body.value);
  return result.ok ? Response.json(result) : refuse(STATUS[result.reason], result.reason);
}

/**
 * The first run (ADR-0013): with the token set at deploy, the Access login making this request
 * becomes the owner. It works only while no owner exists.
 */
async function bootstrap(accessSub: string, input: unknown, deps: AdminDeps): Promise<Response> {
  if (await deps.directory.ownerExists()) return refuse(410, "bootstrap_disabled");
  const { token } = (input ?? {}) as { token?: unknown };
  if (!(await isValidBootstrapToken(token, deps.bootstrapToken, deps.now()))) {
    return refuse(403, "invalid_bootstrap_token");
  }
  const result = await deps.directory.bootstrapOwner(deps.newUserId(), accessSub);
  if (!result.ok) {
    return result.reason === "owner_exists"
      ? refuse(410, "bootstrap_disabled")
      : refuse(400, result.reason);
  }
  return Response.json({ ok: true }, { status: 201 });
}

/** Compares in constant time, and honors the expiry the configured token carries. */
async function isValidBootstrapToken(
  presented: unknown,
  configured: string | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!configured || typeof presented !== "string") return false;
  const [expiresAt] = configured.split(".");
  const expiry = Number(expiresAt);
  if (!Number.isInteger(expiry) || nowMs / 1_000 > expiry) return false;
  const [a, b] = await Promise.all([digest(presented), digest(configured)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string }> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, reason: "too_large" };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, reason: "too_large" };
  }
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, reason: "invalid_json" };
  }
}

function refuse(status: number, reason: string): Response {
  return Response.json({ ok: false, reason }, { status });
}

/** Error names only: messages can carry request content. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
