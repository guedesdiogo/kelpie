import type { Verification } from "@kelpie/access";
import {
  ACCESS_SOURCE,
  ADMIN_AGENT_ID,
  type Admission,
  type ChannelIdentity,
  type OwnerResult,
  type RelinkResult,
} from "@kelpie/access";
import {
  type Actor,
  type CommandResult,
  type ConfigCommands,
  isAgentId,
  type SetupEvent,
} from "@kelpie/config";
import {
  closedPage,
  type FormDeps,
  formTokenOf,
  page,
  showForm,
  submitForm,
  unavailablePage,
} from "./forms.ts";
import {
  noAgentPage,
  notConnectedPage,
  pairedPage,
  pairingAgentOf,
  pairingPage,
} from "./pairing.ts";
import { PAGES, pageLocale } from "./texts.ts";

/** What the API needs from outside, so tests can replace it. */
export interface AdminDeps {
  /** Verifies the request's Cloudflare Access JWT. */
  authenticate(request: Request): Promise<Verification>;
  directory: {
    admit(identity: ChannelIdentity, agentId: string): Promise<Admission>;
    ownerExists(): Promise<boolean>;
    bootstrapOwner(userId: string, accessSub: string): Promise<OwnerResult>;
    relinkOwnerAccess(accessSub: string, tokenHash: string): Promise<RelinkResult>;
  };
  commands: ConfigCommands;
  /** The one-time secure forms in channel-egress. */
  forms: FormDeps;
  /** Reports a setup step the owner finished to the agent's AgentHost (#206). */
  setupDone(agentId: string, event: SetupEvent): Promise<void>;
  /** The first-run token set at deploy (ADR-0013): `<expiry in epoch seconds>.<random>`. */
  bootstrapToken: string | undefined;
  /**
   * The recovery token (#71), in the same format. Set only while the owner recovers their Access
   * login, then deleted; while it is unset, recovery is refused.
   */
  recoveryToken: string | undefined;
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
  not_paired: 409,
  not_connected: 409,
  unavailable: 503,
  not_configured: 503,
  channel_refused: 502,
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
  enableIdentity: (commands, actor, input) => commands.enableIdentity(actor, input),
  disableIdentity: (commands, actor, input) => commands.disableIdentity(actor, input),
  setTimeZone: (commands, actor, input) => commands.setTimeZone(actor, input),
  connectTelegram: (commands, actor, input) => commands.connectTelegram(actor, input),
  pairTelegram: (commands, actor, input) => commands.pairTelegram(actor, input),
  registerTelegramWebhook: (commands, actor, input) =>
    commands.registerTelegramWebhook(actor, input),
  listHeldFiles: (commands, actor) => commands.listHeldFiles(actor),
  forgetVaultPaths: (commands, actor, input) => commands.forgetVaultPaths(actor, input),
  setDream: (commands, actor, input) => commands.setDream(actor, input),
};

/**
 * The owner's admin API (Story 3.10). Cloudflare Access sits in front of it; every request still
 * verifies the Access JWT, and the `Directory` decides who the caller is.
 */
export async function handle(request: Request, deps: AdminDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/forms/")) return handleForm(request, pathname, deps);
  const pairing = pairingAgentOf(pathname);
  if (pairing !== null) return handlePairing(request, pairing, deps);
  const command = pathname.startsWith("/commands/") ? pathname.slice("/commands/".length) : null;
  const tokenRoute = pathname === "/bootstrap" || pathname === "/recover";
  if (request.method !== "POST" || (!tokenRoute && !command)) {
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
  // The Access cookie may go with another site's POST (its SameSite is the Access application's
  // setting), so a page elsewhere must not be able to send a command: no foreign origin, and only
  // `application/json`, which no form can send and no other origin can `fetch` without a preflight.
  // Only here does a request with no `Origin` pass: `cloudflared access curl` sends none (#169).
  const foreign = !isSameOriginSubmission(request, { allowNoOrigin: true });
  if (foreign || !isJson(request)) {
    const reason = foreign ? "cross_origin" : "not_json";
    console.warn("admin-api: request refused", { reason });
    return refuse(foreign ? 403 : 415, reason);
  }

  const body = await readJson(request);
  if (!body.ok) return refuse(body.status, body.reason);

  try {
    if (pathname === "/bootstrap") return await bootstrap(identity.sub, body.value, deps);
    if (pathname === "/recover") return await recover(identity.sub, body.value, deps);
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
  const locale = pageLocale(request);
  const texts = PAGES[locale];
  const answer = (status: number, { title }: { title: string }, body: string) =>
    page(status, title, `<p>${body}</p>`, locale);
  const token = formTokenOf(pathname);
  if (!token || (request.method !== "GET" && request.method !== "POST")) return closedPage(locale);
  try {
    const identity = await deps.authenticate(request);
    if (!identity.ok) return answer(401, texts.signIn, texts.signIn.body);
    if (request.method === "POST" && !isSameOriginSubmission(request)) {
      return answer(403, texts.notAllowed, texts.notAllowed.ownForm);
    }
    const admission = await deps.directory.admit(
      { channel: ACCESS_SOURCE, channelUserId: identity.sub },
      ADMIN_AGENT_ID,
    );
    if (!admission.admitted || admission.role !== "owner") {
      return answer(403, texts.notAllowed, texts.notAllowed.ownerOnly);
    }
    if (request.method === "GET") return await showForm(token, deps.forms, locale);
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      return answer(415, texts.notSubmission, texts.notSubmission.form);
    }
    const body = await readBody(request);
    if (!body.ok) return answer(body.status, texts.tooLarge, texts.tooLarge.body);
    const botToken = new URLSearchParams(body.text).get("botToken") ?? "";
    // The conversation that sent the form learns the bot is connected (#206).
    const { userId } = admission;
    return await submitForm(token, botToken, deps.forms, locale, (agentId, bot, registered) =>
      deps.setupDone(agentId, {
        step: "telegram_connected",
        userId,
        bot,
        webhookRegistered: registered,
      }),
    );
  } catch (error) {
    console.error("admin-api: form failed", errorName(error));
    return unavailablePage(locale);
  }
}

/**
 * The page that pairs the owner's Telegram account with an agent's bot (Story 3.11), for the owner
 * only, with the same checks as the secure forms. `GET` shows a button; its own `POST` runs
 * `pairTelegram` and shows the `t.me` link. Answers are pages, never JSON.
 */
async function handlePairing(
  request: Request,
  agentId: string,
  deps: AdminDeps,
): Promise<Response> {
  const locale = pageLocale(request);
  const texts = PAGES[locale];
  const answer = (status: number, { title }: { title: string }, body: string) =>
    page(status, title, `<p>${body}</p>`, locale);
  if (!isAgentId(agentId) || (request.method !== "GET" && request.method !== "POST")) {
    return noAgentPage(locale);
  }
  try {
    const identity = await deps.authenticate(request);
    if (!identity.ok) return answer(401, texts.signIn, texts.signIn.body);
    if (request.method === "POST" && !isSameOriginSubmission(request)) {
      return answer(403, texts.notAllowed, texts.notAllowed.ownPage);
    }
    const admission = await deps.directory.admit(
      { channel: ACCESS_SOURCE, channelUserId: identity.sub },
      ADMIN_AGENT_ID,
    );
    if (!admission.admitted || admission.role !== "owner") {
      return answer(403, texts.notAllowed, texts.notAllowed.ownerOnly);
    }
    const actor: Actor = { userId: admission.userId, role: admission.role, via: "admin-api" };
    const agent = await deps.commands.getAgent(actor, { id: agentId });
    if (!agent.ok) {
      return agent.reason === "unknown_agent" ? noAgentPage(locale) : unavailablePage(locale);
    }
    if (request.method === "GET") return pairingPage(agent.value, locale);
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      return answer(415, texts.notSubmission, texts.notSubmission.page);
    }
    const result = await deps.commands.pairTelegram(actor, { agentId });
    if (result.ok) {
      return pairedPage(result.value.link, result.value.expiresAt, deps.now(), locale);
    }
    return result.reason === "not_connected" ? notConnectedPage(locale) : unavailablePage(locale);
  } catch (error) {
    console.error("admin-api: pairing page failed", errorName(error));
    return unavailablePage(locale);
  }
}

/**
 * Whether a POST came from this origin's own pages. Browsers say so in `Sec-Fetch-Site`; without
 * it, the `Origin` must be this origin's. Current browsers send at least one of them on a POST, so a
 * request with neither came from no page, and passes only with `allowNoOrigin`: a client such as
 * curl.
 * (The form pages' referrer policy is `same-origin`, so the browser sends the real origin: under
 * `no-referrer` it would send `null`.)
 */
function isSameOriginSubmission(
  request: Request,
  options: { allowNoOrigin?: boolean } = {},
): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null) return options.allowNoOrigin ?? false;
  return origin === new URL(request.url).origin;
}

/**
 * Whether the media type is exactly `application/json`, parameters aside. A substring match would
 * take `text/plain;application/json`, which a page elsewhere can send without a preflight.
 */
function isJson(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
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
  if (!(await isValidDeployToken(token, deps.bootstrapToken, deps.now()))) {
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

/**
 * Recovery (#71): with the recovery token set at deploy, the Access login making this request
 * replaces the owner's, when Access gave the owner a new `sub`. The owner's data stays. The
 * `Directory` gets the token's hash, so each token works once.
 */
async function recover(accessSub: string, input: unknown, deps: AdminDeps): Promise<Response> {
  const { token } = (input ?? {}) as { token?: unknown };
  const configured = deps.recoveryToken;
  // A recovery token is short-lived and its own: one that lives past a day, or that is also the
  // bootstrap token, is refused, so a forgotten secret can't serve as a standing credential.
  const expiry = Number(configured?.match(DEPLOY_TOKEN_FORMAT)?.[1]);
  if (
    typeof token !== "string" ||
    configured === deps.bootstrapToken ||
    !(expiry * 1_000 <= deps.now() + MAX_RECOVERY_TOKEN_LIFETIME_MS) ||
    !(await isValidDeployToken(token, configured, deps.now()))
  ) {
    return refused("invalid_recovery_token", 403);
  }
  const hash = [...new Uint8Array(await digest(token))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const result = await deps.directory.relinkOwnerAccess(accessSub, hash);
  if (result.ok) return Response.json({ ok: true });
  if (result.reason === "no_owner") return refused("no_owner", 403);
  if (result.reason === "token_spent") return refused("recovery_token_spent", 410);
  return refused(result.reason, result.reason === "identity_taken" ? 409 : 400);
}

/** A refused recovery is logged by its reason only: never the token, never the login. */
function refused(reason: string, status: number): Response {
  console.warn("admin-api: recovery refused", { reason });
  return refuse(status, reason);
}

const MAX_RECOVERY_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;

/** `<expiry in epoch seconds>.<at least 128 random bits in hex>`, as `docs/admin-api.md` makes it. */
const DEPLOY_TOKEN_FORMAT = /^(\d{1,12})\.[0-9a-f]{32,}$/;

/**
 * Compares in constant time, and honors the expiry the configured token carries. A configured
 * token in any other format is never accepted.
 */
async function isValidDeployToken(
  presented: unknown,
  configured: string | undefined,
  nowMs: number,
): Promise<boolean> {
  const format = configured?.match(DEPLOY_TOKEN_FORMAT);
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
