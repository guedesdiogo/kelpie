import { LlmError, type LlmErrorCode } from "./errors.ts";
import type { LlmEvent } from "./types.ts";

/** One line of the stream between llm-gateway and its callers. */
export type WireFrame =
  | LlmEvent
  | { type: "error"; code: LlmErrorCode; retryable: boolean; message: string };

// Provider error messages can quote request details or part of a key, so only these go out.
const WIRE_MESSAGES: Record<LlmErrorCode, string> = {
  rate_limited: "The provider is rate limiting requests",
  server_error: "The provider failed",
  connection: "The provider could not be reached",
  auth: "The provider rejected the credentials",
  bad_request: "The provider rejected the request",
  aborted: "The request was aborted",
  unavailable: "No provider is configured for this tier",
  protocol: "The provider answered in an unexpected way",
  internal: "llm-gateway failed",
};

/**
 * Encodes events as newline-delimited JSON in a byte stream, the only kind of stream Workers RPC
 * carries. A failure becomes a last `error` frame with a fixed message; `onError` receives the
 * original error, for logging. Cancelling the stream calls `onCancel`, which should abort the
 * provider request.
 */
export function toNdjsonStream(
  events: AsyncIterable<LlmEvent>,
  onCancel: () => void,
  onError?: (error: unknown) => void,
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
        onError?.(error);
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
  const code = error instanceof LlmError ? error.code : "internal";
  const retryable = error instanceof LlmError && error.retryable;
  return { type: "error", code, retryable, message: WIRE_MESSAGES[code] };
}

/**
 * Decodes a stream made by `toNdjsonStream`. An `error` frame throws it as an `LlmError`, and so
 * does a stream that ends before the `finish` event. Stopping before `finish` also calls `onStop`,
 * which should cancel the call on the sending side.
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
        const frame = parseFrame(text);
        if (frame.type === "error") throw new LlmError(frame.message, frame.code, frame.retryable);
        if (frame.type === "finish") finished = true;
        yield frame;
      }
    }
  } finally {
    // Neither cleanup step may replace the error that ended the stream.
    await Promise.allSettled([
      reader.cancel(),
      ...(finished || !onStop ? [] : [Promise.resolve().then(onStop)]),
    ]);
  }
  if (!finished) {
    throw new LlmError("The stream ended before the reply finished", "connection", true);
  }
}

function parseFrame(text: string): WireFrame {
  try {
    return JSON.parse(text) as WireFrame;
  } catch {
    throw new LlmError("llm-gateway sent a line that isn't JSON", "protocol", false);
  }
}
