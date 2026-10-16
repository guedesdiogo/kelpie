import type { Role } from "@kelpie/access";
import { type Block, formatReply } from "@kelpie/channels";
import type { Mascot } from "@kelpie/config";
import type { ChatType, WebchatAdmission } from "@kelpie/conversation/contract";
import type { ChatMessage } from "@kelpie/llm";
import type { ConversationPorts, TurnStep } from "./ports.ts";
import type { ToolActivity } from "./tools.ts";
import { chatTypeOf, roleOf } from "./turn-access.ts";

// The webchat's socket protocol (issue #40). The socket lives on the conversation's object;
// ingress verifies the owner's Cloudflare Access login and admits them before the upgrade.

/**
 * What the browser sends: a message with an id of its own choosing, whether it is typing, a pause
 * that holds every answer until the next message, or a press of a notice's Confirm button, by the
 * confirmation's id (#186). A pause and a press name their agent (ADR-0052 §3): a confirmation's
 * id is its own conversation's counter. A page from before ADR-0052 names none.
 */
export type ClientFrame =
  | { type: "message"; id: string; text: string }
  | { type: "typing"; active: boolean }
  | { type: "pause"; agent?: string }
  | { type: "confirm"; id: number; agent?: string };

/** An open confirmation as the webchat lists it (ADR-0052 §2): its summary, in full, and its times. */
export interface OpenRequest {
  id: number;
  summary: string;
  /** How long ago a turn last asked for it, and how long until it expires, in ms. */
  askedAgoMs: number;
  expiresInMs: number;
}

/** The open confirmations, newest first, at most 10, and how many more there are. */
export interface OpenRequests {
  requests: OpenRequest[];
  more: number;
}

/** The turn a presence socket sees running: how long ago it began, and its latest step. */
export interface RunningTurn {
  agoMs: number;
  step: TurnStep | null;
  label?: string;
  activity?: ToolActivity;
}

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

/** When the wait before a reply ends, as the page draws its bar. */
export interface WaitDeadline {
  remainingMs: number;
  /** The wait's whole length, so a socket that opens in the middle draws what is left of it. */
  spanMs: number;
  holding: boolean;
}

/** What the page receives. */
export type ServerFrame =
  /**
   * The conversation so far, and the ids of the page's latest messages it has received: the page
   * shows and resends only the ones it doesn't list.
   */
  | { type: "history"; messages: ShownMessage[]; received: string[]; paused: boolean }
  /** The agent's mascot (ADR-0045), after the history. */
  | { type: "agent"; mascot: Mascot }
  /**
   * A reply's bubble comes formatted (#188). Kelpie's own notices come as written, a link notice
   * formatted with its one link, and a confirmation's with the id its button sends (#186). The
   * notice of a turn no route answered is marked `failed`, for the mascot's error.
   */
  | { type: "bubble"; text: string; blocks?: Block[]; confirmation?: number; failed?: true }
  | { type: "typing"; active: boolean }
  /**
   * What the turn is doing (#141); `idle` once it stopped without a reply. A tool's step names its
   * activity, for the mascot's object (ADR-0045 §10); a tool without one has none.
   */
  | { type: "status"; status: TurnStep; label?: string; activity?: ToolActivity }
  /**
   * The wait before Kelpie answers (ADR-0043 §5): how long until the turn reads the buffered
   * messages, and how long the wait is from the latest one, in ms, so the browser's clock doesn't
   * matter. `holding` while the owner's typing holds it. `null` once it is over: the turn reads the
   * messages, or a pause cancelled them.
   */
  | { type: "wait"; deadline: WaitDeadline | null }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "accepted"; id: string }
  | { type: "rejected"; id: string; reason: string }
  /** What a press of a Confirm button did: refused for a confirmation not open, or not theirs. */
  | { type: "confirmation"; id: number; status: "accepted" | "refused" }
  /** The open confirmations (ADR-0052 §4), to both views, when they change. */
  | ({ type: "requests" } & OpenRequests)
  /** A presence socket's first frame (ADR-0052 §2): what the conversation knows now. */
  | ({
      type: "presence";
      turn: RunningTurn | null;
      /** Whether the latest turn settled `failed`, for 5.9's Error. */
      failed: boolean;
      paused: boolean;
    } & OpenRequests)
  /** A turn settled `failed`, to presence sockets. */
  | { type: "failed" };

/** What a presence socket may get (ADR-0052 §2); every other frame stays off it. */
export const PRESENCE_FRAMES: ReadonlySet<ServerFrame["type"]> = new Set([
  "presence",
  "status",
  "failed",
  "paused",
  "resumed",
  "requests",
  "confirmation",
]);

/**
 * Who ingress admitted for a socket. The role and chat type are null when it named none, as before
 * #131, or an unknown one: the socket stays open, and its turns see only their conversation.
 */
export type SocketAdmission = Omit<WebchatAdmission, "role" | "chatType"> & {
  role: Role | null;
  chatType: ChatType | null;
  /** When the socket opened, so the presence cap closes the oldest after hibernation too. */
  openedAt?: number;
};

export function parseAdmission(value: string | null): SocketAdmission | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WebchatAdmission> | null;
    // A view this conversation doesn't know isn't admitted (ADR-0052 §1).
    const view = parsed?.view ?? null;
    if (view !== null && view !== "presence") return null;
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
        // The browser's language (#187); an older ingress names none.
        language: typeof parsed.language === "string" ? parsed.language : null,
        ...(view === "presence" ? { view } : {}),
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
  // The agent a pause or a press names (ADR-0052 §3), when the page names one.
  const agent = typeof frame?.agent === "string" ? { agent: frame.agent } : {};
  if (frame?.type === "pause") return { type: "pause", ...agent };
  if (frame?.type === "confirm" && Number.isSafeInteger(frame.id) && (frame.id as number) > 0) {
    return { type: "confirm", id: frame.id as number, ...agent };
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
 * shown it. A notice isn't history: a socket opened once its turn has settled doesn't get it, and
 * asking the agent again shows it again.
 */
export function webchatEgress(
  broadcast: (frame: ServerFrame) => void,
): Pick<ConversationPorts, "send" | "typing" | "keepTyping" | "status"> {
  return {
    async send(_agentId, _destination, text, options) {
      broadcast({
        type: "bubble",
        text,
        ...(options.links === undefined
          ? {}
          : { blocks: formatReply(text, new Set(options.links)) }),
        ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
        ...(options.failure ? { failed: true } : {}),
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
    async status(_agentId, _destination, step, label, activity) {
      broadcast({
        type: "status",
        status: step,
        ...(label === undefined ? {} : { label }),
        ...(activity === undefined ? {} : { activity }),
      });
    },
  };
}
