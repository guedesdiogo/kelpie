import {
  ACCESS_SOURCE,
  type Admission,
  type ChannelIdentity,
  type Verification,
} from "@kelpie/access";
import { isAgentId } from "@kelpie/config";
import { WEBCHAT_ADMISSION_HEADER, type WebchatAdmission } from "@kelpie/conversation/contract";
import { conversationName } from "./telegram-webhook.ts";

export const WEBCHAT_PATH = "/webchat";
const SOCKET_PATH = `${WEBCHAT_PATH}/ws`;

export interface WebchatDeps {
  /** Verifies the Cloudflare Access token on the request. */
  authenticate(request: Request): Promise<Verification>;
  admit(identity: ChannelIdentity, agentId: string): Promise<Admission>;
  /** Whether the agent is in the registry: the Directory admits the owner for any agent id. */
  agentExists(agentId: string): Promise<boolean>;
  /** The static page, from Workers assets. */
  page(request: Request): Promise<Response>;
  /** Opens the socket on the conversation's object. */
  connect(name: string, admission: WebchatAdmission): Promise<Response>;
}

/**
 * The page holds no secret, but it renders model output, so it may run only its own code. Some
 * Safari versions don't match 'self' to wss:, so the socket's origin is named.
 */
const pageHeaders = (host: string) => ({
  "content-security-policy": `default-src 'self'; connect-src 'self' wss://${host}; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

/**
 * The webchat (issue #40) serves only the owner, who logs in through Cloudflare Access, as for
 * the admin API. Access covers the path at the edge, and this checks its token again on every
 * request: the page, and the socket's upgrade. The owner's Access identity, which the first-run
 * bootstrap registered, is what the Directory admits; the webchat has no pairing of its own. The
 * Directory admits the owner for any agent, so the agent must also be in the registry.
 * While Access isn't configured, the webchat answers 404.
 */
export async function handleWebchat(request: Request, deps: WebchatDeps): Promise<Response> {
  const verification = await deps.authenticate(request);
  if (!verification.ok) {
    return new Response(null, { status: verification.reason === "not_configured" ? 404 : 403 });
  }
  const url = new URL(request.url);
  if (url.pathname !== SOCKET_PATH) {
    const page = await deps.page(request);
    const response = new Response(page.body, page);
    for (const [name, value] of Object.entries(pageHeaders(url.host))) {
      response.headers.set(name, value);
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
  return deps.connect(conversationName(agentId, { channel: "webchat", threadId: userId }), {
    agentId,
    userId,
    role,
    chatType: "direct",
    timeZone,
  });
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
