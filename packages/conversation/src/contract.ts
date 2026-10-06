import type { ChannelId } from "@kelpie/channels";

// The ConversationAgent's contract with ingress, which reaches it through a Durable Object binding
// to another Worker. It has its own entry point (`@kelpie/conversation/contract`), so ingress
// imports these types without the rest of the package.

/** Where a conversation's replies go. */
export interface Destination {
  channel: ChannelId;
  threadId: string;
}

/** One inbound message, already admitted by `ingress` (ADR-0004, ADR-0015). */
export interface InboundMessage {
  /** The agent that answers; its `AgentHost` holds the settings. */
  agentId: string;
  providerMessageId: string;
  /** The admitted author. */
  userId: string;
  text: string;
  destination: Destination;
  /** When the provider says the message was sent (epoch ms). */
  sentAt: number;
  /** The author's IANA time zone, from their admission, or null while they haven't set one. */
  timeZone: string | null;
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
}

export type PauseResult =
  | { status: "paused" | "duplicate" }
  | { status: "rejected"; reason: "destination_mismatch" | "agent_mismatch" };

/** What ingress calls on a conversation's object. */
export interface ConversationContract {
  ingest(message: InboundMessage): Promise<IngestResult>;
  /** Holds every answer until the owner's next message (issue #134). */
  pause(target: PauseTarget): Promise<PauseResult>;
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
  timeZone: string | null;
}
