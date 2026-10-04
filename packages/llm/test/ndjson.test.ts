import { describe, expect, it } from "vitest";
import { LlmError } from "../src/errors.ts";
import { fromNdjsonStream, toNdjsonStream } from "../src/ndjson.ts";
import type { LlmEvent } from "../src/types.ts";
import { collect } from "./fake-fetch.ts";

const finish: LlmEvent = {
  type: "finish",
  reason: "stop",
  message: {
    role: "assistant",
    parts: [{ type: "text", text: "Olá, tudo bem? 👋" }],
    native: { provider: "anthropic", model: "claude-opus-5-5", content: [] },
  },
  usage: [{ model: "claude-opus-5-5", inputUncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }],
};

async function* events(list: LlmEvent[], error?: Error): AsyncIterable<LlmEvent> {
  yield* list;
  if (error) throw error;
}

/** Re-chunks a byte stream into pieces of `size` bytes, to split frames and characters. */
async function rechunk(stream: ReadableStream<Uint8Array>, size: number) {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

describe("NDJSON stream", () => {
  it("round-trips events, even when chunks split frames and characters", async () => {
    const sent: LlmEvent[] = [
      { type: "text", delta: "Olá, " },
      { type: "text", delta: "tudo bem? 👋" },
      finish,
    ];
    const stream = await rechunk(
      toNdjsonStream(events(sent), () => {}),
      7,
    );

    let stopped = false;

    expect(
      await collect(
        fromNdjsonStream(stream, () => {
          stopped = true;
        }),
      ),
    ).toEqual(sent);
    expect(stopped).toBe(false);
  });

  it("carries a failure as an error frame without the provider's message", async () => {
    const failure = new LlmError("Incorrect API key provided: sk-****abcd", "auth", false);
    const logged: unknown[] = [];
    const stream = toNdjsonStream(
      events([{ type: "text", delta: "Hi" }], failure),
      () => {},
      (error) => logged.push(error),
    );
    const received: LlmEvent[] = [];

    await expect(
      (async () => {
        for await (const event of fromNdjsonStream(stream)) received.push(event);
      })(),
    ).rejects.toMatchObject({
      code: "auth",
      retryable: false,
      message: "The provider rejected the credentials",
    });
    expect(received).toEqual([{ type: "text", delta: "Hi" }]);
    expect(logged).toEqual([failure]);
  });

  it("reports an unexpected error as internal", async () => {
    const stream = toNdjsonStream(events([], new TypeError("bug")), () => {});

    await expect(collect(fromNdjsonStream(stream))).rejects.toMatchObject({
      code: "internal",
      retryable: false,
    });
  });

  it("fails when the stream ends before the finish event", async () => {
    const stream = toNdjsonStream(events([{ type: "text", delta: "Hi" }]), () => {});
    const failure = collect(fromNdjsonStream(stream));

    await expect(failure).rejects.toBeInstanceOf(LlmError);
    await expect(failure).rejects.toMatchObject({ code: "connection", retryable: true });
  });

  it("cancels the producer and calls onStop when the consumer stops early", async () => {
    let cancelled = false;
    let stopped = false;
    let producerClosed = false;
    async function* endless(): AsyncIterable<LlmEvent> {
      try {
        while (true) yield { type: "text", delta: "." };
      } finally {
        producerClosed = true;
      }
    }
    const stream = toNdjsonStream(endless(), () => {
      cancelled = true;
    });

    for await (const _event of fromNdjsonStream(stream, () => {
      stopped = true;
    })) {
      break;
    }

    expect(stopped).toBe(true);
    expect(cancelled).toBe(true);
    expect(producerClosed).toBe(true);
  });

  it("cancels the stream when the consumer stops right after finish", async () => {
    let cancelled = false;
    let stopped = false;
    async function* finishThenHang(): AsyncIterable<LlmEvent> {
      yield finish;
      await new Promise(() => {});
    }
    const stream = toNdjsonStream(finishThenHang(), () => {
      cancelled = true;
    });

    for await (const event of fromNdjsonStream(stream, () => {
      stopped = true;
    })) {
      if (event.type === "finish") break;
    }

    expect(cancelled).toBe(true);
    expect(stopped).toBe(false);
  });

  it("keeps the stream's error when onStop fails", async () => {
    const stream = toNdjsonStream(
      events([], new LlmError("overloaded", "server_error", true)),
      () => {},
    );

    await expect(
      collect(
        fromNdjsonStream(stream, () => {
          throw new Error("RPC session closed");
        }),
      ),
    ).rejects.toMatchObject({ code: "server_error", retryable: true });
  });

  it("reports a line that isn't JSON as a protocol error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>oops</html>\n"));
        controller.close();
      },
    });

    await expect(collect(fromNdjsonStream(stream))).rejects.toMatchObject({
      code: "protocol",
      retryable: false,
    });
  });
});
