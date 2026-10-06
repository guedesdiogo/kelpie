import { env, exports } from "cloudflare:workers";
import { fromNdjsonStream, type LlmEvent, type RoutedRequest } from "@kelpie/llm";
import type { Question } from "@kelpie/qualifier";
import { afterEach, describe, expect, it, vi } from "vitest";
import { embedWith, providerConfig, qualifyWith } from "../src/index.ts";

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
// Recorded from Workers AI in spike #117 (2026-10-06, clef-flash).
const RECORDED_CLEF = {
  model: "clef-flash",
  answers: { "turn.end__user_finished": { type: "noul", noul: 0.9323 } },
  usage: { input_tokens: 181, output_tokens: 0 },
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
    const run = vi.fn(async () => RECORDED_CLEF);
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
        answers: { "turn.end::user_finished": { type: "noul", noul: 0.9323 } },
        provider: "clef-workers-ai",
        calibrated: true,
      },
    });
    const [model, input, options] = (run.mock.calls[0] ?? []) as unknown as [
      string,
      Record<string, unknown>,
      { signal?: AbortSignal },
    ];
    expect(model).toBe("@cf/cloudflare/clef");
    expect(input).toMatchObject({ model: "clef", state: { fragments: ["vocês entregam?"] } });
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

  it("answers not_configured when Jev is asked for by name without its key", async () => {
    const { TYPESAFE_API_KEY: _key, ...withoutJev } = env as Parameters<typeof qualifyWith>[0];
    expect(await qualifyWith(withoutJev, { fragments: ["oi"] }, questions, "jev")).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("answers failed, and logs it, when the AI binding is missing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { AI: _ai, ...withoutAi } = env as Parameters<typeof qualifyWith>[0];
    const outcome = await qualifyWith(
      withoutAi as Parameters<typeof qualifyWith>[0],
      { fragments: ["oi"] },
      questions,
      "clef",
    );
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(logged).toHaveBeenCalledOnce();
  });

  it("refuses a backend it doesn't know instead of falling back to Jev", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await qualifyWith(
      env as Parameters<typeof qualifyWith>[0],
      { fragments: ["oi"] },
      questions,
      "openrouter" as "jev",
    );
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 404 over HTTP", async () => {
    const response = await exports.default.fetch("https://llm-gateway.example/");
    expect(response.status).toBe(404);
  });
});

describe("embed", () => {
  type GatewayEnv = Parameters<typeof embedWith>[0];

  it("embeds with bge-m3 on the AI binding by default, and needs no key", async () => {
    const run = vi.fn(async (_model: string, input: { text: string[] }) => ({
      shape: [input.text.length, 3],
      data: input.text.map((_, i) => [i, 0.5, 1]),
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const outcome = await embedWith({ ...(env as GatewayEnv), AI: { run } as unknown as Ai }, [
      "Onde a Ana mora?",
      "Ana mora no Porto.",
    ]);
    expect(outcome).toEqual({
      ok: true,
      model: "@cf/baai/bge-m3",
      vectors: [
        [0, 0.5, 1],
        [1, 0.5, 1],
      ],
    });
    expect(run.mock.calls[0]?.[0]).toBe("@cf/baai/bge-m3");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("embeds through OpenAI when the instance chooses it", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ data: [{ index: 0, embedding: [0.25, 0.75] }] }),
      );
    const outcome = await embedWith(
      { ...(env as GatewayEnv), EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "test-key" },
      ["oi"],
    );
    expect(outcome).toEqual({ ok: true, model: "text-embedding-3-small", vectors: [[0.25, 0.75]] });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/embeddings");
  });

  it("answers not_configured for OpenAI without its key, and invalid for bad input", async () => {
    const { OPENAI_API_KEY: _key, ...withoutKey } = env as GatewayEnv;
    expect(await embedWith({ ...withoutKey, EMBEDDING_PROVIDER: "openai" }, ["oi"])).toEqual({
      ok: false,
      reason: "not_configured",
    });
    for (const texts of [[], [1], Array.from({ length: 257 }, () => "x")]) {
      expect(await embedWith(env as GatewayEnv, texts as string[])).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("refuses empty texts and holes, and answers not_configured for an unknown provider", async () => {
    // biome-ignore lint/suspicious/noSparseArray: a hole is what this checks
    for (const texts of [["oi", ""], ["  "], [, "oi"]]) {
      expect(await embedWith(env as GatewayEnv, texts as string[])).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await embedWith({ ...(env as GatewayEnv), EMBEDDING_PROVIDER: "cohere" }, ["oi"]),
    ).toEqual({ ok: false, reason: "not_configured" });
    expect(JSON.stringify(logged.mock.calls)).toContain("unknown EMBEDDING_PROVIDER: cohere");
  });

  it("logs a timeout as one", async () => {
    const run = vi.fn(
      (_model: string, _input: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason)),
        ),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await embedWith(
      { ...(env as GatewayEnv), AI: { run } as unknown as Ai },
      ["oi"],
      20,
    );
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(JSON.stringify(logged.mock.calls)).toContain("embed timed out");
  });

  it("sends AI Gateway's token, and logs a refused key by its kind only", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          error: {
            message: "Incorrect API key provided: sk-proj-****wxyz",
            code: "invalid_api_key",
          },
        },
        { status: 401 },
      ),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await embedWith(
      {
        ...(env as GatewayEnv),
        EMBEDDING_PROVIDER: "openai",
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://gateway.ai.cloudflare.com/v1/acct/kelpie/openai",
        AI_GATEWAY_TOKEN: "gateway-token",
      },
      ["oi"],
    );
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(JSON.stringify(logged.mock.calls)).toContain("embed failed: auth");
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/sk-|wxyz/);
  });

  it("answers failed when Workers AI fails, and logs only the failure's kind", async () => {
    const run = vi.fn(async () => {
      const error = new Error("bad input: a senha é hunter2hunter2");
      error.name = "InferenceUpstreamError";
      throw error;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await embedWith({ ...(env as GatewayEnv), AI: { run } as unknown as Ai }, [
      "oi",
    ]);
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(JSON.stringify(logged.mock.calls)).toContain("embed failed: server_error");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("hunter2");
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
