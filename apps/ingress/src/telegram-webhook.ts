import type { Admission, ChannelIdentity, DirectoryContract, Remote } from "@kelpie/access";
import {
  type CanonicalEvent,
  type ChannelWebhooksContract,
  type EgressDestination,
  InvalidWebhookError,
  type WebhookNotice,
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
/** `/start`, as a deep link sends it: `t.me/<bot>?start=<payload>` arrives as `/start <payload>`. */
const START_COMMAND = /^\/start(?:\s+(\S+))?\s*$/;

export interface TelegramWebhookDeps {
  webhooks: ChannelWebhooksContract;
  admit(event: CanonicalEvent): Promise<Admission>;
  directory: Pick<
    Remote<DirectoryContract>,
    "redeemPairingCode" | "noticeStranger" | "releaseStrangerNotice"
  >;
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
 * - A stranger gets nothing. Their `/start <code>` may pair them, with a code the owner issued;
 *   anything else is noticed to the owner once (Story 3.6). A `/start` never reaches the model.
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
  // Media isn't handled yet; a caption alone doesn't make a message.
  const text = event.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const start = START_COMMAND.exec(text.trim());
  const admission = await deps.admit(event);
  if (!admission.admitted) {
    console.warn("ingress: dropped a Telegram message", admission.reason);
    if (admission.reason === "unknown_identity") await fromStranger(event, start?.[1], deps);
    return;
  }
  if (start) {
    console.warn("ingress: dropped a Telegram message", "start_command");
    return;
  }
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
 * A direct message from someone not admitted. A `/start <code>` is tried as a pairing code, and a
 * match is confirmed to the account that sent it. Anything else may be noticed to the owner, on
 * the owner's own chat with the bot: in Telegram a private chat's id is the user's id.
 */
async function fromStranger(
  event: CanonicalEvent,
  code: string | undefined,
  deps: TelegramWebhookDeps,
): Promise<void> {
  const sender: ChannelIdentity = {
    channel: event.channel,
    channelUserId: event.sender.channelUserId,
  };
  if (code) {
    const paired = await deps.directory.redeemPairingCode(code, sender);
    if (!paired.ok) {
      console.warn("ingress: a pairing code was refused", paired.reason);
      return;
    }
    await notify(
      deps,
      event.agentId,
      { channel: event.channel, threadId: event.threadId },
      {
        kind: "paired",
      },
    );
    return;
  }
  // A notice is optional: whatever fails on its way is logged, and the webhook answers 200.
  try {
    const notice = await deps.directory.noticeStranger(sender);
    if (!notice.notify) return;
    const stranger: WebhookNotice = { kind: "stranger", senderId: sender.channelUserId };
    if (event.sender.displayName) stranger.displayName = event.sender.displayName;
    const sent = await notify(
      deps,
      event.agentId,
      { channel: event.channel, threadId: notice.ownerChannelUserId },
      stranger,
    );
    // Unsent, it shouldn't count: the stranger's next message can try again.
    if (!sent) await deps.directory.releaseStrangerNotice(sender);
  } catch (error) {
    console.warn("ingress: a stranger notice failed", errorName(error));
  }
}

/** Best effort: a notice that can't be sent is logged, and the webhook still answers 200. */
async function notify(
  deps: TelegramWebhookDeps,
  agentId: string,
  destination: EgressDestination,
  notice: WebhookNotice,
): Promise<boolean> {
  try {
    const sent = await deps.webhooks.notice(agentId, destination, notice);
    if (!sent.ok) console.warn("ingress: a notice wasn't sent", notice.kind, sent.reason);
    return sent.ok;
  } catch (error) {
    console.warn("ingress: a notice wasn't sent", notice.kind, errorName(error));
    return false;
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
