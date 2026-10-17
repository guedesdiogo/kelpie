import {
  ACCESS_SOURCE,
  type Admission,
  type ChannelIdentity,
  type Verification,
} from "@kelpie/access";
import { MAX_LANGUAGE_CHARS } from "@kelpie/channels";
import {
  type Actor,
  type AgentEditorContract,
  type AgentEntry,
  type CommandResult,
  isAgentId,
  isAgentName,
  type Mascot,
  parseMascot,
  parseSettings,
} from "@kelpie/config";
import { WEBCHAT_ADMISSION_HEADER, type WebchatAdmission } from "@kelpie/conversation/contract";
import { bounded } from "./agent-files.ts";
import { conversationName } from "./telegram-webhook.ts";

export const WEBCHAT_PATH = "/webchat";
const SOCKET_PATH = `${WEBCHAT_PATH}/ws`;
const AGENTS_PATH = `${WEBCHAT_PATH}/agents`;
/** The self-hosted fonts (ADR-0043 §2), whose file names carry their version. */
const FONTS_PATH = `${WEBCHAT_PATH}/fonts/`;

export interface WebchatDeps {
  /** Verifies the Cloudflare Access token on the request. */
  authenticate(request: Request): Promise<Verification>;
  admit(identity: ChannelIdentity, agentId: string): Promise<Admission>;
  /** Whether the agent is in the registry: the Directory admits the owner to any id it doesn't know. */
  agentExists(agentId: string): Promise<boolean>;
  /** The registry's agents, in its order, for the page's switcher (#140). */
  listAgents(): Promise<Pick<AgentEntry, "id" | "name" | "role" | "chat">[]>;
  /**
   * How each agent shows, its mascot, specialty and remit, through conversation-runtime's
   * read-only AgentLooks (ADR-0052 §7, #379).
   */
  looks(agentIds: string[]): Promise<Record<string, unknown>>;
  /** conversation-runtime's AgentEditor, the editor's one way to change an agent (#379). */
  editor: AgentEditorContract;
  /** The static page, from Workers assets. */
  page(request: Request): Promise<Response>;
  /** Opens the socket on the conversation's object. */
  connect(name: string, admission: WebchatAdmission): Promise<Response>;
}

/**
 * The page holds no secret, but it renders model output, so it may run only its own code. Some
 * Safari versions don't match 'self' to wss:, so the socket's origin is named. The mascot's fur
 * is painted in the page and shown as blob: images (ADR-0045 §8); model output never makes one,
 * since it reaches the page only as text.
 */
const pageHeaders = (host: string) => ({
  "content-security-policy": `default-src 'self'; connect-src 'self' wss://${host}; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

/**
 * The webchat (issue #40) serves only the owner, who logs in through Cloudflare Access, as for
 * the admin API. Access covers the path at the edge, and this checks its token again on every
 * request: the page, and the socket's upgrade. The owner's Access identity, which the first-run
 * bootstrap registered, is what the Directory admits; the webchat has no pairing of its own. The
 * Directory refuses an agent whose chat is off (#288), and admits the owner to an id it doesn't
 * know, so the agent must also be in the registry.
 * While Access isn't configured, the webchat answers 404.
 */
export async function handleWebchat(request: Request, deps: WebchatDeps): Promise<Response> {
  const verification = await deps.authenticate(request);
  if (!verification.ok) {
    return new Response(null, { status: verification.reason === "not_configured" ? 404 : 403 });
  }
  const url = new URL(request.url);
  if (url.pathname === AGENTS_PATH) return agentList(verification.sub, deps);
  if (url.pathname !== SOCKET_PATH) {
    const page = await deps.page(request);
    const response = new Response(page.body, page);
    for (const [name, value] of Object.entries(pageHeaders(url.host))) {
      response.headers.set(name, value);
    }
    // Everything else keeps its name across deploys; a font's name changes with its version.
    if (url.pathname.startsWith(FONTS_PATH) && page.ok) {
      response.headers.set("cache-control", "private, max-age=31536000, immutable");
    }
    return response;
  }

  // Browsers send cookies, and so the Access token, with any site's WebSocket: only the page's
  // own origin may open one.
  if (request.headers.get("origin") !== url.origin) return new Response(null, { status: 403 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(null, { status: 426 });
  }
  // The sidebar's presence view (ADR-0052 §1), or the conversation's own socket; nothing else.
  const view = url.searchParams.get("view");
  if (view !== null && view !== "presence") return new Response(null, { status: 400 });
  const agentId = url.searchParams.get("agent");
  if (!isAgentId(agentId) || !(await deps.agentExists(agentId))) {
    return new Response(null, { status: 404 });
  }
  const admission = await deps.admit(
    { channel: ACCESS_SOURCE, channelUserId: verification.sub },
    agentId,
  );
  if (!admission.admitted) return new Response(null, { status: 403 });
  const { userId, role, timeZone } = admission;
  // The browser's language, for Kelpie's fixed texts (#187): the page names it on the socket's URL,
  // since not every browser sends Accept-Language with a socket. Not a security input.
  // An empty `lang`, from a browser that names none, leaves the header to say.
  const language = (
    url.searchParams.get("lang") ||
    request.headers.get("accept-language") ||
    ""
  ).slice(0, MAX_LANGUAGE_CHARS);
  return deps.connect(conversationName(agentId, { channel: "webchat", threadId: userId }), {
    agentId,
    userId,
    role,
    chatType: "direct",
    timeZone,
    ...(language === "" ? {} : { language }),
    ...(view === "presence" ? { view } : {}),
  });
}

/** The mascots are only how the rows look: the list waits this long for them, then answers without. */
export const MASCOTS_WITHIN_MS = 1_500;

/** `promise`'s value, or `fallback` once `ms` have passed. */
async function within<T>(ms: number, promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * The agents the page's switcher lists (#140): those that chat, in the registry's order, each one
 * only if the Directory admits this login to it as it would admit its socket. A login it admits to
 * none learns no names.
 */
async function agentList(sub: string, deps: WebchatDeps): Promise<Response> {
  const identity: ChannelIdentity = { channel: ACCESS_SOURCE, channelUserId: sub };
  // Only an explicit `false`, as the Directory reads it: a registry from before #288 names none.
  const chatting = (await deps.listAgents()).filter((agent) => agent.chat !== false);
  const admitted = await Promise.all(
    chatting.map(async (agent) => (await deps.admit(identity, agent.id)).admitted),
  );
  const listed = chatting.filter((_, index) => admitted[index]);
  if (listed.length === 0) return new Response(null, { status: 403 });
  // Each row draws its agent's mascot before its socket opens (ADR-0052 §7). Without them, the list
  // still answers; a value that isn't a mascot, or a line, never reaches the page.
  const looks = await within(
    MASCOTS_WITHIN_MS,
    deps.looks(listed.map(({ id }) => id)).catch(() => ({})),
    {},
  );
  const agents = listed.map(({ id, name, role }) => {
    const look = ((looks as Record<string, unknown>)[id] ?? {}) as Record<string, unknown>;
    const mascot: Mascot | null = parseMascot(look.mascot ?? null);
    // The editor's profile (#379): one line each, as the settings hold them.
    const lines = parseSettings({ specialty: look.specialty, remit: look.remit });
    return {
      id,
      name,
      main: role === "main",
      ...(mascot ? { mascot } : {}),
      ...(lines ? lines : {}),
    };
  });
  return Response.json(
    { agents },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}

/**
 * Opens the socket on the conversation's object with a request built here: the browser's headers,
 * its cookies and its Access token among them, never reach the conversation.
 */
export function connectWebchat(
  env: Env,
  name: string,
  admission: WebchatAdmission,
): Promise<Response> {
  return env.CONVERSATION_AGENT.getByName(name).fetch("https://conversation/webchat", {
    headers: { Upgrade: "websocket", [WEBCHAT_ADMISSION_HEADER]: JSON.stringify(admission) },
  });
}

/** The editor's routes (#379): `/webchat/agents/<id>/mascot` and `/webchat/agents/<id>/profile`. */
const EDIT_PATH = new RegExp(`^${AGENTS_PATH}/([^/]+)/(mascot|profile)$`);
export const isAgentEditPath = (pathname: string) => pathname.startsWith(`${AGENTS_PATH}/`);
/** Far more than a mascot or a profile takes, in bytes. */
const MAX_EDIT_BODY = 4_096;
const EDIT_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
/** The profile's fields, in the order they are set: the one the main agent refuses goes first. */
const PROFILE_FIELDS = ["specialty", "remit", "name"] as const;

const STATUS_OF: Partial<Record<Extract<CommandResult<unknown>, { ok: false }>["reason"], number>> =
  {
    forbidden: 403,
    invalid_input: 400,
    unknown_agent: 404,
    not_allowed: 409,
  };
/** A refusal's status; a profile names the fields it set before the refused one, if any. */
function refused(result: Extract<CommandResult<unknown>, { ok: false }> | null, saved = {}) {
  const status = result ? (STATUS_OF[result.reason] ?? 503) : 503;
  if (Object.keys(saved).length === 0) return new Response(null, { status, headers: EDIT_HEADERS });
  return Response.json({ saved }, { status, headers: EDIT_HEADERS });
}

/**
 * The agent editor's saves (#379): a `PUT` from the webchat's own page, with the owner's Access
 * login, for an agent the Directory admits this login to. The mascot is set whole, from a body
 * `parseMascot` takes; the profile sets the fields it names, each checked before any is set. Each
 * goes through conversation-runtime's AgentEditor, as the actor the Directory resolved: the
 * binding's four methods are what ingress can change. Browsers send the Access cookie with any
 * site's request, so the origin and the fetch's metadata must both say it came from this page. The
 * body is read only for the owner, and never past 4 KB.
 */
export async function handleAgentEdit(request: Request, deps: WebchatDeps): Promise<Response> {
  const verification = await deps.authenticate(request);
  if (!verification.ok) {
    return new Response(null, { status: verification.reason === "not_configured" ? 404 : 403 });
  }
  const url = new URL(request.url);
  if (
    request.headers.get("origin") !== url.origin ||
    request.headers.get("sec-fetch-site") !== "same-origin"
  ) {
    return new Response(null, { status: 403 });
  }
  const matched = EDIT_PATH.exec(url.pathname);
  const agentId = matched?.[1] ?? null;
  if (!matched || !isAgentId(agentId) || !(await deps.agentExists(agentId))) {
    return new Response(null, { status: 404 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return new Response(null, { status: 415 });
  }
  const admission = await deps.admit(
    { channel: ACCESS_SOURCE, channelUserId: verification.sub },
    agentId,
  );
  if (!admission.admitted || admission.role !== "owner") return new Response(null, { status: 403 });
  const bytes = await bounded(request, MAX_EDIT_BODY);
  if (bytes === null) return new Response(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return new Response(null, { status: 400 });
  }
  const actor: Actor = { userId: admission.userId, role: admission.role, via: "webchat" };
  if (matched[2] === "mascot") {
    const mascot = parseMascot(body);
    if (!mascot) return new Response(null, { status: 400 });
    try {
      const result = await deps.editor.setMascot(actor, agentId, mascot);
      if (!result.ok) return refused(result);
      // What goes back to the page is a mascot, checked as the list checks it.
      const shown = parseMascot(result.value);
      return shown ? Response.json({ mascot: shown }, { headers: EDIT_HEADERS }) : refused(null);
    } catch (error) {
      console.warn("webchat: an agent's mascot wasn't saved", errorName(error));
      return refused(null);
    }
  }
  const profile = parseProfile(body);
  if (!profile) return new Response(null, { status: 400 });
  const saved: Partial<Record<(typeof PROFILE_FIELDS)[number], string>> = {};
  for (const field of PROFILE_FIELDS) {
    const value = profile[field];
    if (value === undefined) continue;
    try {
      const result =
        field === "name"
          ? await deps.editor.rename(actor, agentId, value)
          : field === "remit"
            ? await deps.editor.setRemit(actor, agentId, value)
            : await deps.editor.setSpecialty(actor, agentId, value);
      if (!result.ok) return refused(result, saved);
      if (typeof result.value !== "string") return refused(null, saved);
      saved[field] = result.value;
    } catch (error) {
      console.warn("webchat: an agent's profile wasn't saved", errorName(error));
      return refused(null, saved);
    }
  }
  return Response.json(saved, { headers: EDIT_HEADERS });
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "");

/** The profile's fields the page sent, each one a value the agent takes, or null. */
function parseProfile(
  body: unknown,
): Partial<Record<(typeof PROFILE_FIELDS)[number], string>> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { name, remit, specialty, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (name === undefined && remit === undefined && specialty === undefined) return null;
  if (name !== undefined && !isAgentName(name)) return null;
  const lines = parseSettings({
    ...(remit === undefined ? {} : { remit }),
    ...(specialty === undefined ? {} : { specialty }),
  });
  if (!lines) return null;
  return { ...(name === undefined ? {} : { name: name as string }), ...lines };
}
