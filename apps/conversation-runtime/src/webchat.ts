import type { Role } from "@kelpie/access";
import { type Block, formatReply } from "@kelpie/channels";
import type { ChatType, WebchatAdmission } from "@kelpie/conversation/contract";
import type { ChatMessage } from "@kelpie/llm";
import type { ConversationPorts, TurnStep } from "./ports.ts";
import { chatTypeOf, roleOf } from "./turn-access.ts";

// The webchat's socket protocol (issue #40). The socket lives on the conversation's object;
// ingress verifies the owner's Cloudflare Access login and admits them before the upgrade.

/**
 * What the browser sends: a message with an id of its own choosing, whether it is typing, a pause
 * that holds every answer until the next message, or a press of a notice's Confirm button, by the
 * confirmation's id (#186).
 */
export type ClientFrame =
  | { type: "message"; id: string; text: string }
  | { type: "typing"; active: boolean }
  | { type: "pause" }
  | { type: "confirm"; id: number };

/** One line of the conversation as the page shows it. */
export interface ShownMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
  /** A reply, formatted with the links it may show (#188); the page shows `text` without it. */
  blocks?: Block[];
  /** A confirmation's notice: the id its Confirm button sends (#186). Never on a reply. */
  confirmation?: number;
}

/** What the page receives. */
export type ServerFrame =
  /**
   * The conversation so far, and the ids of the page's latest messages it has received: the page
   * shows and resends only the ones it doesn't list.
   */
  | { type: "history"; messages: ShownMessage[]; received: string[]; paused: boolean }
  /**
   * A reply's bubble comes formatted (#188). Kelpie's own notices come as written, a link notice
   * formatted with its one link, and a confirmation's with the id its button sends (#186).
   */
  | { type: "bubble"; text: string; blocks?: Block[]; confirmation?: number }
  | { type: "typing"; active: boolean }
  /** What the turn is doing (#141); `idle` once it stopped without a reply. */
  | { type: "status"; status: TurnStep; label?: string }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "accepted"; id: string }
  | { type: "rejected"; id: string; reason: string }
  /** What a press of a Confirm button did: refused when the confirmation isn't open, or not theirs. */
  | { type: "confirmation"; id: number; status: "accepted" | "refused" };

/**
 * Who ingress admitted for a socket. The role and chat type are null when it named none, as before
 * #131, or an unknown one: the socket stays open, and its turns see only their conversation.
 */
export type SocketAdmission = Omit<WebchatAdmission, "role" | "chatType"> & {
  role: Role | null;
  chatType: ChatType | null;
};

export function parseAdmission(value: string | null): SocketAdmission | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WebchatAdmission> | null;
    if (
      typeof parsed?.agentId === "string" &&
      typeof parsed.userId === "string" &&
      (parsed.timeZone === null || typeof parsed.timeZone === "string")
    ) {
      return {
        agentId: parsed.agentId,
        userId: parsed.userId,
        role: roleOf(parsed.role),
        chatType: chatTypeOf(parsed.chatType),
        timeZone: parsed.timeZone,
      };
    }
  } catch {
    // Not JSON: not something ingress sent.
  }
  return null;
}

/** A frame from the browser, or null for anything else: binary, not JSON, or an unknown shape. */
export function parseClientFrame(message: unknown): ClientFrame | null {
  if (typeof message !== "string") return null;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(message) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (frame?.type === "message") {
    const { id, text } = frame;
    return typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id) && typeof text === "string"
      ? { type: "message", id, text }
      : null;
  }
  if (frame?.type === "typing" && typeof frame.active === "boolean") {
    return { type: "typing", active: frame.active };
  }
  if (frame?.type === "pause") return { type: "pause" };
  if (frame?.type === "confirm" && Number.isSafeInteger(frame.id) && (frame.id as number) > 0) {
    return { type: "confirm", id: frame.id as number };
  }
  return null;
}

/** The text a message shows: its text parts, with no tool calls, tool results or reasoning. */
export function shownText(message: ChatMessage): string {
  if (!("parts" in message)) return "";
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

/**
 * The webchat's side of the channel ports: replies go to the conversation's open sockets. With
 * none open, a bubble still counts as delivered, because history keeps it and the next socket is
 * shown it.
 */
export function webchatEgress(
  sockets: () => Iterable<{ send(data: string): void }>,
): Pick<ConversationPorts, "send" | "typing" | "keepTyping" | "status"> {
  const broadcast = (frame: ServerFrame) => {
    const data = JSON.stringify(frame);
    for (const socket of sockets()) {
      try {
        socket.send(data);
      } catch {
        // A socket closing mid-send misses this frame; the next one it opens replays history.
      }
    }
  };
  return {
    async send(_agentId, _destination, text, options) {
      broadcast({
        type: "bubble",
        text,
        ...(options.links === undefined
          ? {}
          : { blocks: formatReply(text, new Set(options.links)) }),
        ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
      });
      return { ok: true, providerMessageId: `webchat:${crypto.randomUUID()}` };
    },
    async typing() {
      broadcast({ type: "typing", active: true });
    },
    // The page's indicator lasts until the next bubble, so it needs no renewal.
    async keepTyping() {
      broadcast({ type: "typing", active: true });
    },
    async status(_agentId, _destination, step, label) {
      broadcast(
        label === undefined
          ? { type: "status", status: step }
          : { type: "status", status: step, label },
      );
    },
  };
}
