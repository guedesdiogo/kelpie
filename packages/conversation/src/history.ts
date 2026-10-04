import type { AssistantMessage } from "@kelpie/llm";

/**
 * What the conversation keeps of a reply once delivery ends, so the model knows what the user saw:
 * - every bubble sent: the reply as the model produced it, native output included;
 * - interrupted after some bubbles: only their text, as a neutral message. The native output is
 *   dropped, because it describes the whole reply, not what was delivered;
 * - nothing sent: nothing.
 */
export function deliveredReply(
  reply: AssistantMessage,
  bubbles: readonly string[],
  sent: number,
): AssistantMessage | null {
  if (sent <= 0) return null;
  if (sent >= bubbles.length) return reply;
  return {
    role: "assistant",
    parts: [{ type: "text", text: bubbles.slice(0, sent).join("\n\n") }],
  };
}
