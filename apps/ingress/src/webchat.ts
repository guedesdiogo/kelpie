import {
  ACCESS_SOURCE,
  type Admission,
  type ChannelIdentity,
  type Verification,
} from "@kelpie/access";
import { MAX_LANGUAGE_CHARS } from "@kelpie/channels";
import { type AgentEntry, isAgentId } from "@kelpie/config";
import { WEBCHAT_ADMISSION_HEADER, type WebchatAdmission } from "@kelpie/conversation/contract";
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
  });
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
  const agents = chatting
    .filter((_, index) => admitted[index])
    .map(({ id, name, role }) => ({ id, name, main: role === "main" }));
  if (agents.length === 0) return new Response(null, { status: 403 });
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
