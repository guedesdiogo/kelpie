import { LlmError, type LlmErrorCode } from "./errors.ts";
import type { LlmEvent } from "./types.ts";

/** One line of the stream between llm-gateway and its callers. */
export type WireFrame =
  | LlmEvent
  | { type: "error"; code: LlmErrorCode; retryable: boolean; message: string };

/**
 * Encodes events as newline-delimited JSON in a byte stream, the only kind of stream Workers RPC
 * carries. A failure becomes a last `error` frame. Cancelling the stream calls `onCancel`, which
 * should abort the provider request.
 */
export function toNdjsonStream(
  events: AsyncIterable<LlmEvent>,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  const line = (frame: WireFrame) => encoder.encode(`${JSON.stringify(frame)}\n`);
  let cancelled = false;
  return new ReadableStream({
    type: "bytes",
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(line(next.value));
      } catch (error) {
        if (cancelled) return;
        controller.enqueue(line(toErrorFrame(error)));
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      onCancel();
      await iterator.return?.();
    },
  });
}

function toErrorFrame(error: unknown): WireFrame {
  if (error instanceof LlmError) {
    return { type: "error", code: error.code, retryable: error.retryable, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: "error", code: "internal", retryable: false, message };
}

/**
 * Decodes a stream made by `toNdjsonStream`. An `error` frame throws it as an `LlmError`, and so
 * does a stream that ends before the `finish` event. Stopping before `finish` cancels the stream
 * and calls `onStop`, which should cancel the call on the sending side.
 */
export async function* fromNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  onStop?: () => unknown,
): AsyncIterable<LlmEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) {
        const frame = JSON.parse(text) as WireFrame;
        if (frame.type === "error") throw new LlmError(frame.message, frame.code, frame.retryable);
        if (frame.type === "finish") finished = true;
        yield frame;
      }
    }
  } finally {
    if (!finished) await Promise.all([onStop?.(), reader.cancel()]);
  }
  if (!finished) {
    throw new LlmError("The stream ended before the reply finished", "connection", true);
  }
}
