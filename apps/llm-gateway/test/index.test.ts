import { exports } from "cloudflare:workers";
import { fromNdjsonStream, type LlmEvent, type RoutedRequest } from "@kelpie/llm";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Worker runs in the test's isolate, so stubbing the global fetch stands in for the provider.
// The stream is built from Anthropic's documented event format, not recorded.

const request: RoutedRequest = {
  system: "You are Kelpie.",
  messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
  maxOutputTokens: 1024,
};

const encoder = new TextEncoder();
const frame = (event: { type: string }) =>
  encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

const start = {
  type: "message_start",
  message: {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  },
};
const text = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Olá!" } },
];
const end = [
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];

function sseResponse(events: { type: string }[], signal?: AbortSignal | null) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(frame(event));
        if (!signal) controller.close();
        else signal.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("llm-gateway", () => {
  it("streams a tier's reply over RPC as NDJSON events", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sseResponse([start, ...text, ...end]));

    using generation = await exports.LlmGateway.generate("cheap", request);
    const events: LlmEvent[] = [];
    for await (const event of fromNdjsonStream(await generation.events())) events.push(event);

    expect(events[0]).toEqual({ type: "text", delta: "Olá!" });
    expect(events[1]).toMatchObject({
      type: "finish",
      reason: "stop",
      message: { parts: [{ type: "text", text: "Olá!" }] },
      usage: [
        { model: "claude-haiku-4-5", inputUncached: 12, cacheRead: 0, cacheWrite: 0, output: 5 },
      ],
    });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-test");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-haiku-4-5" });
  });

  it("aborts the provider request when the caller stops reading", async () => {
    let providerSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      providerSignal = init?.signal;
      return sseResponse([start, ...text], init?.signal);
    });

    using generation = await exports.LlmGateway.generate("cheap", request);
    for await (const _event of fromNdjsonStream(await generation.events(), () =>
      generation.cancel(),
    )) {
      break;
    }

    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
  });

  it("answers 404 over HTTP", async () => {
    const response = await exports.default.fetch("https://llm-gateway.example/");
    expect(response.status).toBe(404);
  });
});
