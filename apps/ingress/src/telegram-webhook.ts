import type { Admission } from "@kelpie/access";
import {
  type CanonicalEvent,
  type ChannelWebhooksContract,
  InvalidWebhookError,
} from "@kelpie/channels";
import { normalizeTelegramUpdate, TELEGRAM_SECRET_HEADER } from "@kelpie/channels/telegram";
import { isAgentId } from "@kelpie/config";
import type { Destination, InboundMessage, IngestResult } from "@kelpie/conversation/contract";

/**
 * Telegram's updates are small: a message's text is at most 4,096 characters, and the message it
 * replies to comes with it. A body past this is dropped unread.
 */
const MAX_BODY_BYTES = 256 * 1024;
/**
 * Telegram's rule for a webhook's `secret_token`. A header that breaks it can't be one, so egress
 * isn't asked: a flood of guesses never reaches the secret store.
 */
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{1,256}$/;

export interface TelegramWebhookDeps {
  webhooks: ChannelWebhooksContract;
  admit(event: CanonicalEvent): Promise<Admission>;
  /** Hands a message to the conversation's object, named by `conversationName`. */
  ingest(name: string, message: InboundMessage): Promise<IngestResult>;
}

/**
 * One webhook from an agent's Telegram bot (`setWebhook` points it at
 * `/webhooks/telegram/<agentId>`).
 *
 * - The secret Telegram echoes is checked by channel-egress, which holds it, before the body is
 *   read. The agent id in the path only says which bot's secret to check: a request can't pick an
 *   agent whose secret it doesn't hold.
 * - A verified update that can't be used is dropped with a 200, or Telegram would send it again:
 *   malformed, too large, from a group or a stranger (ADR-0004), or without text.
 * - The answer comes once the conversation has stored the message. If egress, the Directory or the
 *   conversation fails, a 503 makes Telegram retry, and the conversation drops the duplicate. A
 *   message the conversation fails on every time holds the bot's later updates back until Telegram
 *   gives up on it, after 24 hours.
 */
export async function handleTelegramWebhook(
  request: Request,
  agentId: string,
  deps: TelegramWebhookDeps,
): Promise<Response> {
  if (!isAgentId(agentId)) return new Response(null, { status: 404 });
  const presented = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (presented === null || !WEBHOOK_SECRET.test(presented)) {
    return new Response(null, { status: 401 });
  }
  try {
    const verdict = await deps.webhooks.verifyTelegram(agentId, presented);
    if (!verdict.ok) {
      return new Response(null, { status: verdict.reason === "refused" ? 401 : 503 });
    }
    const body = await readCapped(request);
    if (body === null) return dropped("too_large");
    let events: CanonicalEvent[];
    try {
      events = normalizeTelegramUpdate({ headers: {}, body }, agentId);
    } catch (error) {
      if (error instanceof InvalidWebhookError) return dropped("malformed");
      throw error;
    }
    for (const event of events) await deliver(event, deps);
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("ingress: a Telegram webhook failed", errorName(error));
    return new Response(null, { status: 503 });
  }
}

async function deliver(event: CanonicalEvent, deps: TelegramWebhookDeps): Promise<void> {
  const admission = await deps.admit(event);
  if (!admission.admitted) {
    console.warn("ingress: dropped a Telegram message", admission.reason);
    return;
  }
  // Media isn't handled yet; a caption alone doesn't make a message.
  const text = event.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  if (text === "") {
    console.warn("ingress: dropped a Telegram message", "no_text");
    return;
  }
  const destination: Destination = { channel: event.channel, threadId: event.threadId };
  const result = await deps.ingest(conversationName(event.agentId, destination), {
    agentId: event.agentId,
    providerMessageId: event.providerMessageId,
    userId: admission.userId,
    text,
    destination,
    sentAt: event.providerTimestamp,
    timeZone: admission.timeZone,
  });
  if (result.status === "rejected") {
    console.warn("ingress: the conversation refused a message", result.reason);
  }
}

/**
 * One object per agent and thread: a conversation stays bound to the agent and destination of its
 * first message.
 */
export function conversationName(agentId: string, destination: Destination): string {
  return `${agentId}:${destination.channel}:${destination.threadId}`;
}

function dropped(reason: string): Response {
  console.warn("ingress: dropped a Telegram update", reason);
  return new Response(null, { status: 200 });
}

/** The body up to the size cap, whatever its `Content-Length` says; null past it. */
async function readCapped(request: Request): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Error names only: messages can quote what was sent. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
