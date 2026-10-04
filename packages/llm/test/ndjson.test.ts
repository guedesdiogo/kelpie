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

  it("carries a failure as an error frame", async () => {
    const failure = new LlmError("overloaded", "server_error", true);
    const stream = toNdjsonStream(events([{ type: "text", delta: "Hi" }], failure), () => {});
    const received: LlmEvent[] = [];

    await expect(
      (async () => {
        for await (const event of fromNdjsonStream(stream)) received.push(event);
      })(),
    ).rejects.toMatchObject({ code: "server_error", retryable: true, message: "overloaded" });
    expect(received).toEqual([{ type: "text", delta: "Hi" }]);
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
});
