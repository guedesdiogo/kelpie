// One model call through llm-gateway, for the Context Store's own work: a held file's resolution
// (#114) and Dream's steps (#112).
import {
  fromNdjsonStream,
  type LlmEvent,
  type ModelTier,
  type RoutedRequest,
  type Usage,
} from "@kelpie/llm";

/** A model call through llm-gateway's `generate`, as its RPC stub answers it. */
export interface Generation {
  events(): Promise<ReadableStream<Uint8Array>>;
  cancel(): Promise<void>;
}

export interface ModelGateway {
  generate(tier: ModelTier, request: RoutedRequest): Promise<Generation>;
}

/**
 * The model's whole answer, with what it used. Throws when the model fails, stops short, or hasn't
 * finished after `timeoutMs`, which cancels the call.
 */
export async function complete(
  gateway: ModelGateway,
  tier: ModelTier,
  request: RoutedRequest,
  timeoutMs: number,
): Promise<{ text: string; usage: Usage[] }> {
  const generation = await gateway.generate(tier, request);
  try {
    return await within(finished(generation), timeoutMs, () => {
      generation.cancel().catch(() => undefined);
    });
  } finally {
    // The RPC stub holds the call open until it is disposed.
    const dispose = (Symbol as { dispose?: symbol }).dispose;
    if (dispose !== undefined) {
      (generation as unknown as Partial<Record<symbol, () => void>>)[dispose]?.();
    }
  }
}

/** The answer without a code fence around the whole of it, which models add despite being told. */
export function unfenced(answer: string): string {
  const fenced = /^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(answer);
  return fenced ? `${fenced[1]}\n` : answer;
}

async function finished(generation: Generation): Promise<{ text: string; usage: Usage[] }> {
  let finish: Extract<LlmEvent, { type: "finish" }> | undefined;
  for await (const event of fromNdjsonStream(await generation.events())) {
    if (event.type === "finish") finish = event;
  }
  if (finish === undefined || finish.reason !== "stop") throw new Error("no complete answer");
  return {
    text: finish.message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(""),
    // The gateway is ours, but a frame is only cast: a missing list is none.
    usage: Array.isArray(finish.usage) ? finish.usage : [],
  };
}

/** `call`'s answer, or a rejection after `ms`, when `onLate` stops it. */
async function within<T>(call: Promise<T>, ms: number, onLate: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onLate();
      reject(new Error(`no answer after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([call, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
