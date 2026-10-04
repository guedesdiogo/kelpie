import {
  ACCESS_SOURCE,
  ADMIN_AGENT_ID,
  type Admission,
  type ChannelIdentity,
  type OwnerResult,
} from "@kelpie/access";
import type { Actor, CommandResult, ConfigCommands } from "@kelpie/config";
import type { Verification } from "./access-jwt.ts";
import {
  closedPage,
  type FormDeps,
  formTokenOf,
  page,
  showForm,
  submitForm,
  unavailablePage,
} from "./forms.ts";

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
  /** The one-time secure forms in channel-egress. */
  forms: FormDeps;
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
  unavailable: 503,
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
  setTimeZone: (commands, actor, input) => commands.setTimeZone(actor, input),
  connectTelegram: (commands, actor, input) => commands.connectTelegram(actor, input),
};

/**
 * The owner's admin API (Story 3.10). Cloudflare Access sits in front of it; every request still
 * verifies the Access JWT, and the `Directory` decides who the caller is.
 */
export async function handle(request: Request, deps: AdminDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/forms/")) return handleForm(request, pathname, deps);
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

  try {
    if (pathname === "/bootstrap") return await bootstrap(identity.sub, body.value, deps);
    // `command` is a key of COMMANDS: checked above.
    return await run(COMMANDS[command as string] as Command, identity.sub, body.value, deps);
  } catch (error) {
    console.error("admin-api: request failed", errorName(error));
    return refuse(500, "internal");
  }
}

/**
 * A secure form's page (`GET`) and its submission (`POST`), for the owner only: the same Access
 * check and owner admission as the commands. Answers are pages, never JSON.
 */
async function handleForm(request: Request, pathname: string, deps: AdminDeps): Promise<Response> {
  const token = formTokenOf(pathname);
  if (!token || (request.method !== "GET" && request.method !== "POST")) return closedPage();
  try {
    const identity = await deps.authenticate(request);
    if (!identity.ok)
      return page(401, "Sign in first", "<p>Open this link in your browser again.</p>");
    if (request.method === "POST" && !isSameOriginSubmission(request)) {
      return page(403, "Not allowed", "<p>This form only accepts its own submissions.</p>");
    }
    const admission = await deps.directory.admit(
      { channel: ACCESS_SOURCE, channelUserId: identity.sub },
      ADMIN_AGENT_ID,
    );
    if (!admission.admitted || admission.role !== "owner") {
      return page(403, "Not allowed", "<p>Only the owner can use this link.</p>");
    }
    if (request.method === "GET") return await showForm(token, deps.forms);
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      return page(415, "Not a form submission", "<p>Submit the token from the form page.</p>");
    }
    const body = await readBody(request);
    if (!body.ok) return page(body.status, "Too large", "<p>That isn't a bot token.</p>");
    const botToken = new URLSearchParams(body.text).get("botToken") ?? "";
    return await submitForm(token, botToken, deps.forms);
  } catch (error) {
    console.error("admin-api: form failed", errorName(error));
    return unavailablePage();
  }
}

/**
 * Whether a POST came from the form's own page. Browsers say so in `Sec-Fetch-Site`; without it,
 * a foreign `Origin` is refused. (The page's referrer policy is `same-origin`, so the browser
 * sends the real origin: under `no-referrer` it would send `null`.)
 */
function isSameOriginSubmission(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

async function run(
  command: Command,
  accessSub: string,
  input: unknown,
  deps: AdminDeps,
): Promise<Response> {
  const admission = await deps.directory.admit(
    { channel: ACCESS_SOURCE, channelUserId: accessSub },
    ADMIN_AGENT_ID,
  );
  if (!admission.admitted) {
    return (await deps.directory.ownerExists())
      ? refuse(403, "forbidden")
      : refuse(403, "no_owner");
  }
  const actor: Actor = { userId: admission.userId, role: admission.role, via: "admin-api" };
  const result = await command(deps.commands, actor, input);
  return result.ok ? Response.json(result) : refuse(STATUS[result.reason] ?? 500, result.reason);
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

/** `<expiry in epoch seconds>.<at least 128 random bits in hex>`, as `docs/admin-api.md` makes it. */
const BOOTSTRAP_TOKEN_FORMAT = /^(\d{1,12})\.[0-9a-f]{32,}$/;

/**
 * Compares in constant time, and honors the expiry the configured token carries. A configured
 * token in any other format is never accepted.
 */
async function isValidBootstrapToken(
  presented: unknown,
  configured: string | undefined,
  nowMs: number,
): Promise<boolean> {
  const format = configured?.match(BOOTSTRAP_TOKEN_FORMAT);
  if (!configured || !format || typeof presented !== "string") return false;
  if (nowMs / 1_000 > Number(format[1])) return false;
  const [a, b] = await Promise.all([digest(presented), digest(configured)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** The body as JSON, or undefined when it is empty. */
async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string }> {
  const body = await readBody(request);
  if (!body.ok) return body;
  if (body.text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, status: 400, reason: "invalid_json" };
  }
}

/** Reads the body up to the size cap, whatever its `Content-Length` says. */
async function readBody(
  request: Request,
): Promise<{ ok: true; text: string } | { ok: false; status: number; reason: string }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, status: 413, reason: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

function refuse(status: number, reason: string): Response {
  return Response.json({ ok: false, reason }, { status });
}

/** Error names only: messages can carry request content. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
