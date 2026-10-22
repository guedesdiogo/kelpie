import type { Role } from "@kelpie/access";
import type { CanonicalEvent, ChannelId } from "@kelpie/channels";

// The ConversationAgent's contract with ingress, which reaches it through a Durable Object binding
// to another Worker. It has its own entry point (`@kelpie/conversation/contract`), so ingress
// imports these types without the rest of the package.

/** Where a conversation's replies go. */
export interface Destination {
  channel: ChannelId;
  threadId: string;
}

/** A direct chat or a group: they see different memory (ADR-0004, #131). */
export type ChatType = CanonicalEvent["chatType"];

/** One inbound message, already admitted by `ingress` (ADR-0004, ADR-0015). */
export interface InboundMessage {
  /** The agent that answers; its `AgentHost` holds the settings. */
  agentId: string;
  providerMessageId: string;
  /** The admitted author. */
  userId: string;
  /** The author's role, from their admission. */
  role: Role;
  chatType: ChatType;
  text: string;
  destination: Destination;
  /** When the provider says the message was sent (epoch ms). */
  sentAt: number;
  /** The author's IANA time zone, from their admission, or null while they haven't set one. */
  timeZone: string | null;
  /**
   * The language the author's device or app is set to, as a tag or an `Accept-Language` value,
   * when the channel says: what Kelpie's fixed texts fall back to (#187). An older ingress sends
   * none.
   */
  language?: string | null;
}

export type IngestResult =
  | {
      status: "accepted" | "duplicate";
      /** When the buffered messages will be answered, or null if a turn already started. */
      flushAt: number | null;
    }
  | {
      status: "rejected";
      reason: "destination_mismatch" | "agent_mismatch" | "too_long" | "empty";
    };

/** Which conversation a pause is for: the same binding a message carries. */
export interface PauseTarget {
  agentId: string;
  destination: Destination;
  /** The command's own message id, when the channel retries deliveries. */
  providerMessageId?: string;
  /** The device language of whoever paused, as on a message (#187); an older ingress sends none. */
  language?: string | null;
}

export type PauseResult =
  | { status: "paused" | "duplicate" }
  | { status: "rejected"; reason: "destination_mismatch" | "agent_mismatch" };

/**
 * A tap on a button under one of Kelpie's own notices (ADR-0067 §3), already admitted by ingress:
 * the owner's paired account, in their own chat with the bot. The conversation reads the button's
 * data, acts on it by its own rules, and answers the tap.
 */
export interface PressTarget {
  agentId: string;
  destination: Destination;
  /** The admitted owner. */
  userId: string;
  role: Role;
  chatType: ChatType;
  timeZone: string | null;
  /** The language the owner's app is set to, when the channel says (#187). */
  language?: string | null;
  /** The channel's id for the tap, which the conversation answers. */
  pressId: string;
  /** The notice the button is on. */
  providerMessageId: string;
  /**
   * What Kelpie wrote on the button: an action and the random id of what it acts on, such as
   * `confirm:<id>`. Never a counter or "the latest one" (ADR-0026 §4).
   */
  data: string;
}

/** `refused`: the button acts on nothing open for this owner, and the tap was told so. */
export type PressResult =
  | { status: "accepted" | "refused" }
  | { status: "rejected"; reason: "destination_mismatch" | "agent_mismatch" };

/** What ingress calls on a conversation's object. */
export interface ConversationContract {
  ingest(message: InboundMessage): Promise<IngestResult>;
  /** Holds every answer until the owner's next message (issue #134). */
  pause(target: PauseTarget): Promise<PauseResult>;
  /** Acts on a tap on one of Kelpie's buttons, and answers it (ADR-0067 §3). */
  press(target: PressTarget): Promise<PressResult>;
}

/**
 * The webchat's socket is opened by ingress on the conversation's object, after it verified the
 * owner's Access login. This header carries who it admitted; ingress builds the request, so the
 * browser can't set it.
 */
export const WEBCHAT_ADMISSION_HEADER = "x-kelpie-webchat-admission";

export interface WebchatAdmission {
  agentId: string;
  userId: string;
  role: Role;
  /** The webchat is the owner's own login (ADR-0023): always a direct chat. */
  chatType: ChatType;
  timeZone: string | null;
  /** The browser's language, as the page names it (#187); an older ingress or page sends none. */
  language?: string | null;
  /**
   * The sidebar's presence view (ADR-0052): the socket gets only the conversation's presence, and
   * may send only a card's actions. Without it, the socket is the conversation's own.
   */
  view?: "presence";
}
