import { env, exports } from "cloudflare:workers";
import { fromNdjsonStream, type LlmEvent, type RoutedRequest } from "@kelpie/llm";
import type { Question } from "@kelpie/qualifier";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerConfig, qualifyWith } from "../src/index.ts";

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

// Recorded from TypeSafe's API in the Jev spike (issue #27).
const RECORDED_JEV = {
  model: "jev-1.13.0",
  answers: { "turn.end::user_finished": { type: "noul", noul: 0.87 } },
  usage: { input_tokens: 312, output_tokens: 24 },
};
// Built by hand from the documented output schema of @cf/cloudflare/clef-flash; spike #117 records one.
const DOCUMENTED_CLEF = {
  model: "clef-flash",
  answers: { "turn.end::user_finished": { type: "noul", noul: 0.81 } },
  usage: { input_tokens: 300, output_tokens: 1 },
};
const questions: Record<string, Question> = {
  "turn.end::user_finished": { type: "noul", instructions: "Has the user finished?" },
};

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

  it("asks Jev when the caller names no backend, as conversation-runtime did before Clef", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(RECORDED_JEV));

    const outcome = await exports.LlmGateway.qualify({ fragments: ["vocês entregam?"] }, questions);

    expect(outcome).toEqual({
      ok: true,
      result: {
        answers: { "turn.end::user_finished": { type: "noul", noul: 0.87 } },
        provider: "jev-http",
        calibrated: true,
      },
    });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ts-test");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "jev-1.13.0" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers failed when TypeSafe refuses, and logs the status without the key", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("unauthorized ts-test", { status: 401 }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await exports.LlmGateway.qualify({ fragments: ["oi"] }, questions)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(String(logged.mock.calls[0]?.[0])).toContain("TypeSafe answered 401");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("ts-test");
  });

  it("answers not_configured at once when no Jev key is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { TYPESAFE_API_KEY: _key, ...withoutJev } = env as Parameters<typeof qualifyWith>[0];
    const outcome = await qualifyWith(withoutJev, { fragments: ["oi"] }, questions);
    expect(outcome).toEqual({ ok: false, reason: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks Clef through the AI binding with the pinned model, and needs no key", async () => {
    const run = vi.fn(async () => DOCUMENTED_CLEF);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { TYPESAFE_API_KEY: _key, ...withoutJev } = env as Parameters<typeof qualifyWith>[0];
    const outcome = await qualifyWith(
      { ...withoutJev, AI: { run } as unknown as Ai },
      { fragments: ["vocês entregam?"] },
      questions,
      "clef",
    );

    expect(outcome).toEqual({
      ok: true,
      result: {
        answers: { "turn.end::user_finished": { type: "noul", noul: 0.81 } },
        provider: "clef-workers-ai",
        calibrated: true,
      },
    });
    const [model, input, options] = (run.mock.calls[0] ?? []) as unknown as [
      string,
      Record<string, unknown>,
      { signal?: AbortSignal },
    ];
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(input).toMatchObject({ model: "clef-flash", state: { fragments: ["vocês entregam?"] } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers failed when Workers AI fails, and logs only the error's name", async () => {
    const run = vi.fn(async () => {
      const error = new Error("bad input: meu cpf é 12345678909");
      error.name = "InferenceUpstreamError";
      throw error;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await qualifyWith(
      { ...(env as Parameters<typeof qualifyWith>[0]), AI: { run } as unknown as Ai },
      { fragments: ["oi"] },
      questions,
      "clef",
    );

    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(String(logged.mock.calls[0]?.[0])).toContain(
      "Workers AI failed: InferenceUpstreamError",
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("cpf");
  });

  it("answers 404 over HTTP", async () => {
    const response = await exports.default.fetch("https://llm-gateway.example/");
    expect(response.status).toBe(404);
  });
});

describe("providerConfig", () => {
  it("sends the gateway token only to AI Gateway", () => {
    expect(
      providerConfig(
        "key",
        "https://gateway.ai.cloudflare.com/v1/account/kelpie/anthropic",
        "gateway-token",
      ),
    ).toEqual({
      apiKey: "key",
      baseURL: "https://gateway.ai.cloudflare.com/v1/account/kelpie/anthropic",
      headers: { "cf-aig-authorization": "Bearer gateway-token" },
    });
    expect(providerConfig("key", "https://api.anthropic.com", "gateway-token")).toEqual({
      apiKey: "key",
      baseURL: "https://api.anthropic.com",
    });
  });

  it("refuses a base URL without https", () => {
    expect(() => providerConfig("key", "http://api.anthropic.com")).toThrow(/https/);
  });
});
