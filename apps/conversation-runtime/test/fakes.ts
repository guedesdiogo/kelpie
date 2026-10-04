import type { AssistantMessage, LlmEvent, RoutedRequest } from "@kelpie/llm";
import type { ConversationPorts, Destination, ModelCall } from "../src/ports.ts";

// The Worker runs in the test's isolate, so these fakes replace the ConversationAgent's ports.

type ModelScript =
  | { kind: "reply"; text: string }
  | { kind: "refuse" }
  /** Never answers; ends when the call is cancelled. */
  | { kind: "hang" };

export const reply = (text: string): ModelScript => ({ kind: "reply", text });
export const refuse = (): ModelScript => ({ kind: "refuse" });
export const hang = (): ModelScript => ({ kind: "hang" });

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    parts: [{ type: "text", text }],
    native: { provider: "anthropic", model: "claude-haiku-4-5", content: [{ type: "text", text }] },
  };
}

export interface FakeWorld {
  ports: ConversationPorts;
  requests: RoutedRequest[];
  cancelled: number;
  sent: string[];
  typing: number;
  /** Makes the next sleeps of these call numbers (0-based) wait until the turn is aborted. */
  blockSleeps: Set<number>;
  /** Makes these send call numbers (0-based) never complete. */
  blockSends: Set<number>;
}

export function fakeWorld(scripts: ModelScript[]): FakeWorld {
  let sleeps = 0;
  let sends = 0;
  const world: FakeWorld = {
    requests: [],
    cancelled: 0,
    sent: [],
    typing: 0,
    blockSleeps: new Set(),
    blockSends: new Set(),
    ports: {
      async generate(_tier, request): Promise<ModelCall> {
        world.requests.push(structuredClone(request));
        const script = scripts.shift() ?? reply("(no script left)");
        let release: (() => void) | undefined;
        const cancelledPromise = new Promise<void>((resolve) => {
          release = resolve;
        });
        async function* events(): AsyncIterable<LlmEvent> {
          if (script.kind === "hang") {
            await cancelledPromise;
            throw new Error("cancelled");
          }
          if (script.kind === "refuse") {
            yield { type: "finish", reason: "refusal", message: assistant(""), usage: [] };
            return;
          }
          yield { type: "text", delta: script.text };
          yield { type: "finish", reason: "stop", message: assistant(script.text), usage: [] };
        }
        return {
          events: events(),
          cancel() {
            world.cancelled += 1;
            release?.();
          },
        };
      },
      async send(_destination: Destination, text: string) {
        const call = sends++;
        if (world.blockSends.has(call)) await new Promise(() => {});
        world.sent.push(text);
      },
      async typing() {
        world.typing += 1;
      },
      qualifier: null,
      now: () => Date.now(),
      sleep(_ms, signal) {
        const call = sleeps++;
        if (!world.blockSleeps.has(call)) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    },
  };
  return world;
}
