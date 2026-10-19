import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  AnthropicMessagesProvider,
  fromNdjsonStream,
  MODEL_TIERS,
  parseRouteTable,
  type RoutedRequest,
  type RouterEvent,
  type RouteSession,
} from "@kelpie/llm";
import type { Question } from "@kelpie/qualifier";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureDefaultsWith,
  describeWith,
  embedWith,
  generateWith,
  LlmChat,
  LlmGateway,
  LlmGatewayAdmin,
  pingWith,
  providerConfig,
  providersWith,
  qualifyWith,
  routerOptions,
  routesWith,
} from "../src/index.ts";

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
    model: "claude-haiku-5-5",
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

// The cheap tier's "haiku" alias lists Anthropic's models before the call, unless an earlier test in
// this isolate already resolved it, so Anthropic's stubs answer by path. The page is built from the
// Models API's documented format, not recorded.
const MODELS = {
  data: [
    ["claude-haiku-5-5", "2026-09-15T00:00:00Z"],
    ["claude-haiku-4-5-20251001", "2025-10-01T00:00:00Z"],
  ].map(([id, created_at]) => ({
    type: "model",
    id,
    display_name: id,
    created_at,
    max_input_tokens: 200_000,
    max_tokens: 64_000,
    capabilities: null,
  })),
  has_more: false,
  first_id: "claude-haiku-5-5",
  last_id: "claude-haiku-4-5-20251001",
};

function anthropic(messages: (init?: RequestInit) => Response) {
  return async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("https://api.anthropic.com/v1/models")
      ? Response.json(MODELS)
      : messages(init);
}

const isMessages = ([input]: unknown[]) => String(input).includes("/v1/messages");

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
      .mockImplementation(anthropic(() => sseResponse([start, ...text, ...end])));

    using generation = await exports.LlmGateway.generate("cheap", request);
    const events: RouterEvent[] = [];
    for await (const event of fromNdjsonStream(await generation.events())) events.push(event);

    expect(events[0]).toEqual({ type: "text", delta: "Olá!" });
    expect(events[1]).toMatchObject({
      type: "finish",
      reason: "stop",
      message: { parts: [{ type: "text", text: "Olá!" }] },
      usage: [
        { model: "claude-haiku-5-5", inputUncached: 12, cacheRead: 0, cacheWrite: 0, output: 5 },
      ],
    });
    const [url, init] = fetchSpy.mock.calls.find(isMessages) ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-test");
    // The newest Haiku in the models list, which the cheap tier's alias stands for.
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-haiku-5-5" });
  });

  it("aborts the provider request when the caller stops reading", async () => {
    let providerSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      anthropic((init) => {
        providerSignal = init?.signal;
        return sseResponse([start, ...text], init?.signal);
      }),
    );

    using generation = await exports.LlmGateway.generate("cheap", request);
    for await (const _event of fromNdjsonStream(await generation.events(), () =>
      generation.cancel(),
    )) {
      break;
    }

    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
  });

  it("logs a refused call by its kind and status, never the provider's message", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      anthropic(() =>
        Response.json(
          {
            type: "error",
            error: { type: "invalid_request_error", message: "prompt quotes marker-1a2b" },
          },
          { status: 400 },
        ),
      ),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    using generation = await exports.LlmGateway.generate("cheap", request);
    await expect(async () => {
      for await (const _event of fromNdjsonStream(await generation.events())) {
        // The stream ends with the error.
      }
    }).rejects.toThrow();

    const lines = JSON.stringify(logged.mock.calls);
    expect(lines).toContain("generate failed");
    expect(lines).toContain('"code":"bad_request"');
    expect(lines).toContain('"status":400');
    expect(lines).not.toContain("marker-1a2b");
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
    const lines = JSON.stringify(logged.mock.calls);
    expect(lines).toContain("qualify failed");
    expect(lines).toContain('"error":"TypeSafeError"');
    expect(lines).toContain('"status":401');
    expect(lines).not.toContain("ts-test");
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
    const lines = JSON.stringify(logged.mock.calls);
    expect(lines).toContain("qualify failed");
    expect(lines).toContain('"error":"InferenceUpstreamError"');
    expect(lines).not.toContain("cpf");
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

  it("waits longer for Clef when the caller asks, but never past 3 s", async () => {
    // Clef answers after 1.5 s, or 3.5 s on the third call, unless the gateway gives up first.
    let call = 0;
    const run = vi.fn(
      (_model: string, _input: unknown, options: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          call += 1;
          const timer = setTimeout(() => resolve(RECORDED_CLEF), call === 3 ? 3_500 : 1_500);
          options.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(options.signal?.reason);
          });
        }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const withClef = {
      ...(env as Parameters<typeof qualifyWith>[0]),
      AI: { run } as unknown as Ai,
    };
    const state = { fragments: ["oi"] };
    expect(await qualifyWith(withClef, state, questions, "clef")).toEqual({
      ok: false,
      reason: "failed",
    });
    expect((await qualifyWith(withClef, state, questions, "clef", { timeoutMs: 2_000 })).ok).toBe(
      true,
    );
    expect((await qualifyWith(withClef, state, questions, "clef", { timeoutMs: 10_000 })).ok).toBe(
      false,
    );
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

describe("ping", () => {
  type GatewayEnv = Parameters<typeof pingWith>[0];

  it("loads the configuration over RPC and calls no provider", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    expect(await exports.LlmGateway.ping()).toEqual({ ok: true });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("throws when a route, a provider's base URL or the embedding provider can't load", async () => {
    const base = env as GatewayEnv;
    const broken: Record<string, unknown>[] = [
      { MODEL_ROUTES: { cheap: [{ provider: "mistral", model: "x" }] } },
      { ANTHROPIC_BASE_URL: "http://api.anthropic.com" },
      { EMBEDDING_PROVIDER: "cohere" },
    ];
    for (const change of broken) {
      await expect(pingWith({ ...base, ...change } as GatewayEnv)).rejects.toThrow();
    }
  });
});

describe("routerOptions (#293)", () => {
  it("falls back unless MODEL_FALLBACK is off, a typo included", () => {
    expect(routerOptions({ MODEL_FALLBACK: "on" })).toEqual({ fallback: true });
    expect(routerOptions({ MODEL_FALLBACK: "of" })).toEqual({ fallback: true });
    expect(routerOptions({ MODEL_FALLBACK: "off" })).toEqual({ fallback: false });
  });

  it("is on in the committed configuration", () => {
    expect(routerOptions(env as Parameters<typeof routerOptions>[0])).toEqual({ fallback: true });
  });

  it("reaches the router: off, a failed route ends the call with its route and no other is tried", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        anthropic(() =>
          Response.json(
            { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
            { status: 529 },
          ),
        ),
      );
    const withOpenAI = (fallback: string) =>
      ({ ...env, OPENAI_API_KEY: "sk-test", MODEL_FALLBACK: fallback }) as unknown as Parameters<
        typeof generateWith
      >[0];

    const generation = generateWith(withOpenAI("off"), { area: "conversation" }, request);
    const events: RouterEvent[] = [];
    const failure = (async () => {
      for await (const event of fromNdjsonStream(generation.events())) events.push(event);
    })();
    await expect(failure).rejects.toMatchObject({
      code: "server_error",
      route: { provider: "anthropic" },
    });
    expect(events).toEqual([]);
    expect(
      fetchSpy.mock.calls.some(([input]) => new URL(String(input)).hostname === "api.openai.com"),
    ).toBe(false);
  });
});

describe("routes", () => {
  type GatewayEnv = Parameters<typeof routesWith>[0];

  it("lists each tier's models over RPC, an alias spelled out, and calls no provider", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    // Only Anthropic has a key in the tests, so the OpenAI candidates are left out.
    expect(await exports.LlmGateway.routes()).toEqual({
      cheap: [{ provider: "anthropic", model: "haiku", standsFor: "the newest Claude Haiku" }],
      medium: [{ provider: "anthropic", model: "claude-sonnet-5-5" }],
      frontier: [{ provider: "anthropic", model: "claude-opus-5-5" }],
    });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("lists every configured provider in the route's order", () => {
    const both = { ...(env as GatewayEnv), OPENAI_API_KEY: "sk-test" };
    expect(routesWith(both).frontier).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5" },
      { provider: "openai", model: "gpt-6-astra" },
    ]);
    const { ANTHROPIC_API_KEY: _key, ...openaiOnly } = both;
    expect(routesWith(openaiOnly as GatewayEnv).cheap).toEqual([
      { provider: "openai", model: "gpt-6-luna" },
    ]);
  });
});

describe("model choice (#286)", () => {
  type GatewayEnv = Parameters<typeof describeWith>[0];
  const defaults = () => env.MODEL_DEFAULTS.getByName("instance");

  /** Leaves ModelDefaults as a test needs it; nothing stored means nothing pinned yet. */
  async function seed(values: { pinnedProvider?: string; instance?: unknown }) {
    await runInDurableObject(defaults(), (_instance, state) => {
      state.storage.kv.delete("pinnedProvider");
      state.storage.kv.delete("instance");
      for (const [key, value] of Object.entries(values)) state.storage.kv.put(key, value);
    });
  }

  it("resolves an area's trio, and sends its tier's model and its effort", async () => {
    await seed({});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(anthropic(() => sseResponse([start, ...text, ...end])));

    using generation = await exports.LlmGateway.generate(
      { area: "conversation", agent: { conversation: { tier: "medium", effort: "high" } } },
      request,
    );
    for await (const _event of fromNdjsonStream(await generation.events())) {
      // Read to the end.
    }
    const [, init] = fetchSpy.mock.calls.find(isMessages) ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "claude-sonnet-5-5",
      output_config: { effort: "high" },
    });
  });

  it("pins the first provider with a key, in the cheap tier's order, and keeps it", async () => {
    await seed({});
    expect(await exports.LlmGateway.describe("memory")).toEqual({
      provider: "anthropic",
      tier: "cheap",
      route: [{ provider: "anthropic", model: "haiku", standsFor: "the newest Claude Haiku" }],
    });
    // A key added later doesn't move the pin: its provider only joins the route as a fallback.
    await seed({ pinnedProvider: "openai" });
    const both = { ...(env as GatewayEnv), OPENAI_API_KEY: "sk-test" };
    expect(await describeWith(both, "conversation")).toEqual({
      provider: "openai",
      tier: "cheap",
      route: [
        { provider: "openai", model: "gpt-6-luna" },
        { provider: "anthropic", model: "haiku", standsFor: "the newest Claude Haiku" },
      ],
    });
  });

  it("takes the instance's settings below the agent's, and the caller's tier as the built-in", async () => {
    await seed({ pinnedProvider: "anthropic", instance: { memory: { effort: "low" } } });
    const both = { ...(env as GatewayEnv), OPENAI_API_KEY: "sk-test" };
    expect(await describeWith(both, "memory", { provider: "openai" }, "medium")).toEqual({
      provider: "openai",
      tier: "medium",
      effort: "low",
      route: [
        { provider: "openai", model: "gpt-6.1-sol" },
        { provider: "anthropic", model: "claude-sonnet-5-5" },
      ],
    });
  });

  it("sends a basic instance's conversation what a tier alone sent before #286", async () => {
    await seed({});
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      anthropic((init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([start, ...text, ...end]);
      }),
    );
    for (const call of ["cheap", { area: "conversation", agent: {} }] as const) {
      using generation = await exports.LlmGateway.generate(call, request);
      for await (const _event of fromNdjsonStream(await generation.events())) {
        // Read to the end.
      }
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).not.toHaveProperty("output_config");
  });

  const broken = () =>
    ({
      ...(env as GatewayEnv),
      MODEL_DEFAULTS: {
        getByName: () => ({
          defaults: async () => {
            throw new TypeError("Durable Object reset because its code was updated");
          },
        }),
      },
    }) as unknown as GatewayEnv;

  it("goes on in the route table's order when ModelDefaults fails, and logs only the error's name", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(anthropic(() => sseResponse([start, ...text, ...end])));

    const generation = generateWith(broken(), { area: "conversation" }, request);
    const events: RouterEvent[] = [];
    for await (const event of fromNdjsonStream(generation.events())) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    expect(fetchSpy.mock.calls.some(isMessages)).toBe(true);
    expect(logged).toHaveBeenCalledWith(
      "llm-gateway: ModelDefaults failed; using the route table's order",
      "TypeError",
    );
  });

  it("fails a description when ModelDefaults fails, so the agent keeps its last one", async () => {
    await expect(describeWith(broken(), "conversation")).rejects.toThrow(TypeError);
  });

  it("refuses an unknown area, tier or agent setting instead of guessing", async () => {
    for (const call of [
      { area: "tasks" },
      { area: "memory", tier: "huge" },
      { area: "conversation", agent: { conversation: { model: "gpt-6-astra" } } },
    ]) {
      using generation = await exports.LlmGateway.generate(call as never, request);
      const read = async () => {
        for await (const _event of fromNdjsonStream(await generation.events())) {
          // Read to the end.
        }
      };
      await expect(read()).rejects.toMatchObject({ code: "bad_request" });
    }
  });

  it("wakes ModelDefaults on the deploy's ping, and pins nothing", async () => {
    await seed({});
    expect(await exports.LlmGateway.ping()).toEqual({ ok: true });
    await runInDurableObject(defaults(), (_instance, state) => {
      expect(state.storage.kv.get("pinnedProvider")).toBeUndefined();
    });
  });
});

describe("the instance's model settings (#289)", () => {
  type GatewayEnv = Parameters<typeof describeWith>[0];
  const defaults = () => env.MODEL_DEFAULTS.getByName("instance");
  const owner = { userId: "u-owner", role: "owner", via: "agent:setup" } as const;

  async function reset() {
    await runInDurableObject(defaults(), (_instance, state) => state.storage.deleteAll());
  }

  it("lists the providers that have a key, on the admin entrypoint only", async () => {
    expect(await exports.LlmGatewayAdmin.providers()).toEqual(["anthropic"]);
    // A Worker that binds the model calls alone can't read or change the instance's settings.
    for (const method of ["providers", "instanceModels", "configureDefaults"]) {
      expect(method in LlmGateway.prototype).toBe(false);
      expect(method in LlmGatewayAdmin.prototype).toBe(true);
    }
  });

  it("sets the instance's settings, audits them with their actor, and every call resolves against them", async () => {
    await reset();
    const settings = { conversation: { tier: "medium", effort: "low" } } as const;
    expect(await exports.LlmGatewayAdmin.configureDefaults(settings, owner)).toEqual({ ok: true });
    expect(await exports.LlmGatewayAdmin.instanceModels()).toEqual({
      settings,
      pinned: null,
      providers: ["anthropic"],
      claudeCode: false,
    });
    expect(await exports.LlmGateway.describe("conversation")).toMatchObject({
      tier: "medium",
      effort: "low",
    });
    const audit = await runInDurableObject(defaults(), (_instance, state) =>
      [...state.storage.kv.list({ prefix: "audit:" })].map(([, value]) => value),
    );
    expect(audit).toEqual([
      expect.objectContaining({ userId: "u-owner", via: "agent:setup", settings }),
    ]);
  });

  it("refuses settings it doesn't know, or a provider without a key, and changes nothing", async () => {
    await reset();
    for (const settings of [{ conversation: { model: "x" } }, { provider: "openai" }]) {
      expect(await exports.LlmGatewayAdmin.configureDefaults(settings as never, owner)).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
    expect((await exports.LlmGatewayAdmin.instanceModels()).settings).toEqual({});
    const both = { ...(env as GatewayEnv), OPENAI_API_KEY: "sk-test" };
    expect(await configureDefaultsWith(both, { provider: "openai" }, owner)).toEqual({ ok: true });
    // A write replaces the settings whole, and each is audited, in order, its actor bounded.
    const long = { ...owner, via: "x".repeat(500) };
    expect(await configureDefaultsWith(both, { memory: { tier: "medium" } }, long)).toEqual({
      ok: true,
    });
    expect((await exports.LlmGatewayAdmin.instanceModels()).settings).toEqual({
      memory: { tier: "medium" },
    });
    const audit = await runInDurableObject(defaults(), (_instance, state) =>
      [...state.storage.kv.list({ prefix: "audit:" })].map(
        ([, value]) => value as { via: string; settings: unknown },
      ),
    );
    expect(audit.map((entry) => entry.settings)).toEqual([
      { provider: "openai" },
      { memory: { tier: "medium" } },
    ]);
    expect(audit[1]?.via).toHaveLength(128);
  });
});

describe("a route that runs its own tool loop (#295)", () => {
  type GatewayEnv = Parameters<typeof generateWith>[0];
  const session: RouteSession = {
    conversation: "assistant:telegram:chat-1",
    id: "6c1f2a9e-3b7d-4e51-9a0c-2f8d7e6b5a41",
    resume: true,
    toolLoopMs: 180_000,
  };
  const conversation = { area: "conversation" } as const;
  const call = (id: string) => ({
    type: "tool_call" as const,
    id,
    name: "search_memory",
    input: { query: "Ana" },
  });

  /**
   * A fake provider, standing in for `claude-code`'s: the Anthropic adapter's stream is replaced,
   * so the real gateway and router carry its events and answers. It asks for each call in turn and
   * waits for its result, with `signal` if given, then replies with the outputs.
   */
  function routeLoop(ids: string[], signal?: AbortSignal) {
    const seen: { session?: RouteSession | undefined; waiting?: string; failure?: unknown } = {};
    vi.spyOn(AnthropicMessagesProvider.prototype, "stream").mockImplementation(
      async function* (_request, options) {
        seen.session = options?.session;
        const answers = options?.answers;
        if (!answers) throw new Error("the gateway sent no answers");
        const outputs: string[] = [];
        for (const id of ids) {
          yield { type: "tool_request", call: call(id) };
          seen.waiting = id;
          try {
            outputs.push((await answers.wait(id, signal)).output);
          } catch (error) {
            seen.failure = error;
            throw error;
          }
        }
        yield {
          type: "finish",
          reason: "stop",
          message: { role: "assistant", parts: [{ type: "text", text: outputs.join(" ") }] },
          usage: [],
        };
      },
    );
    return seen;
  }

  const read = async (stream: ReadableStream<Uint8Array>) => {
    const events: RouterEvent[] = [];
    for await (const event of fromNdjsonStream(stream)) events.push(event);
    return events;
  };

  it("passes a session to the route over RPC, only with the fields it knows", async () => {
    const seen = routeLoop([]);
    using generation = await exports.LlmChat.generate(conversation, request, {
      ...session,
      token: "not a session field",
    } as RouteSession);
    expect(await read(await generation.events())).toMatchObject([{ type: "finish" }]);
    expect(seen.session).toEqual(session);
  });

  it("takes a session only on LlmChat, which only conversation-runtime binds (#431, #432)", async () => {
    routeLoop([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect("generate" in LlmChat.prototype).toBe(true);
    // context-store binds LlmGateway and reads outside content: a session sent there is refused,
    // before any route.
    using generation = await exports.LlmGateway.generate(conversation, request, session);
    await expect(read(await generation.events())).rejects.toMatchObject({ code: "bad_request" });
    expect(AnthropicMessagesProvider.prototype.stream).not.toHaveBeenCalled();
  });

  it("refuses a malformed session as a bad request, before any route", async () => {
    routeLoop([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const malformed of [
      null,
      "6c1f2a9e",
      { ...session, id: "" },
      { ...session, id: 42 },
      { ...session, id: "../6c1f2a9e" },
      { ...session, id: "6c1f2a9e" },
      { ...session, conversation: "c".repeat(257) },
      { ...session, resume: "yes" },
      { conversation: session.conversation, id: session.id },
      { conversation: session.conversation, id: session.id, resume: true },
      { ...session, id: "6C1F2A9E-3B7D-4E51-9A0C-2F8D7E6B5A41" },
      { ...session, toolLoopMs: 999 },
      { ...session, toolLoopMs: 3_600_001 },
      { ...session, toolLoopMs: 120_000.5 },
      { ...session, toolLoopMs: "120000" },
    ]) {
      using generation = await exports.LlmChat.generate(
        conversation,
        request,
        malformed as RouteSession,
      );
      await expect(read(await generation.events())).rejects.toMatchObject({
        code: "bad_request",
      });
    }
    expect(AnthropicMessagesProvider.prototype.stream).not.toHaveBeenCalled();
  });

  it("refuses a session on a call that isn't a conversation's, before any route", async () => {
    routeLoop([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const selection of ["medium", { area: "memory" }] as const) {
      using generation = await exports.LlmChat.generate(selection, request, session);
      await expect(read(await generation.events())).rejects.toMatchObject({
        code: "bad_request",
      });
    }
    expect(AnthropicMessagesProvider.prototype.stream).not.toHaveBeenCalled();
  });

  it("gives the route each result the caller answers over RPC, before or after it waits", async () => {
    const seen = routeLoop(["toolu_01", "toolu_02"]);
    using generation = await exports.LlmChat.generate(conversation, request, session);
    const events = fromNdjsonStream(await generation.events())[Symbol.asyncIterator]();

    expect((await events.next()).value).toEqual({ type: "tool_request", call: call("toolu_01") });
    expect(await generation.answer({ callId: "toolu_01", output: "Ana" })).toEqual({ ok: true });
    expect((await events.next()).value).toEqual({ type: "tool_request", call: call("toolu_02") });
    const next = events.next();
    await vi.waitFor(() => expect(seen.waiting).toBe("toolu_02"));
    expect(
      await generation.answer({ callId: "toolu_02", output: "mora no Porto", isError: false }),
    ).toEqual({ ok: true });
    expect((await next).value).toMatchObject({
      type: "finish",
      message: { parts: [{ type: "text", text: "Ana mora no Porto" }] },
    });
  });

  it("ignores an answer that is malformed, for a call that doesn't wait, or late, and says why", async () => {
    routeLoop(["toolu_01"]);
    const generation = generateWith(env as GatewayEnv, conversation, request, session);
    const events = fromNdjsonStream(generation.events())[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: "tool_request" });

    for (const malformed of [
      null,
      { output: "Ana" },
      { callId: "", output: "Ana" },
      { callId: "t".repeat(257), output: "Ana" },
      { callId: "toolu_01", output: 42 },
      { callId: "toolu_01", output: "x".repeat(20_001) },
      { callId: "toolu_01", output: "Ana", isError: "no" },
      // The runner's own checks, which refuse anything more (#421).
      { callId: "toolu_01", output: "Ana", note: "x" },
    ]) {
      expect(generation.answer(malformed as never)).toEqual({
        ok: false,
        reason: "invalid_input",
      });
    }
    expect(generation.answer({ callId: "toolu_99", output: "Ana" })).toEqual({
      ok: false,
      reason: "unknown_call",
    });
    expect(generation.answer({ callId: "toolu_01", output: "Ana" })).toEqual({ ok: true });
    expect(generation.answer({ callId: "toolu_01", output: "again" })).toEqual({
      ok: false,
      reason: "unknown_call",
    });
    expect((await events.next()).value).toMatchObject({
      type: "finish",
      message: { parts: [{ type: "text", text: "Ana" }] },
    });
    expect((await events.next()).done).toBe(true);
    expect(generation.answer({ callId: "toolu_01", output: "late" })).toEqual({
      ok: false,
      reason: "ended",
    });
  });

  it("rejects the route's wait when the call is cancelled", async () => {
    const seen = routeLoop(["toolu_01"]);
    using generation = await exports.LlmChat.generate(conversation, request, session);
    const events = fromNdjsonStream(await generation.events())[Symbol.asyncIterator]();
    await events.next();
    const next = events.next();
    await vi.waitFor(() => expect(seen.waiting).toBe("toolu_01"));

    await generation.cancel();
    await expect(next).rejects.toMatchObject({ code: "aborted" });
    expect(seen.failure).toMatchObject({ code: "aborted" });
    expect(await generation.answer({ callId: "toolu_01", output: "Ana" })).toEqual({
      ok: false,
      reason: "ended",
    });
  });

  it("rejects the route's wait when the caller drops its stub without cancelling", async () => {
    const seen = routeLoop(["toolu_01"]);
    {
      using generation = await exports.LlmChat.generate(conversation, request, session);
      const events = fromNdjsonStream(await generation.events())[Symbol.asyncIterator]();
      await events.next();
      void events.next().catch(() => undefined);
      await vi.waitFor(() => expect(seen.waiting).toBe("toolu_01"));
    }
    await vi.waitFor(() => expect(seen.failure).toMatchObject({ code: "aborted" }));
  });

  it("rejects the route's wait when its own signal aborts", async () => {
    const own = new AbortController();
    const seen = routeLoop(["toolu_01", "toolu_02"], own.signal);
    const generation = generateWith(env as GatewayEnv, conversation, request, session);
    const events = fromNdjsonStream(generation.events())[Symbol.asyncIterator]();
    await events.next();
    expect(generation.answer({ callId: "toolu_01", output: "Ana" })).toEqual({ ok: true });
    await events.next();
    const next = events.next();
    await vi.waitFor(() => expect(seen.waiting).toBe("toolu_02"));

    own.abort();
    await expect(next).rejects.toMatchObject({ code: "aborted" });
    expect(seen.failure).toMatchObject({ code: "aborted" });
  });

  it("refuses a second wait for the same call, and still answers the first", async () => {
    const waits: Promise<unknown>[] = [];
    vi.spyOn(AnthropicMessagesProvider.prototype, "stream").mockImplementation(
      async function* (_request, options) {
        const answers = options?.answers as NonNullable<typeof options>["answers"] & {};
        yield { type: "tool_request", call: call("toolu_01") };
        const first = answers.wait("toolu_01");
        waits.push(
          first,
          answers.wait("toolu_01").catch((error: unknown) => error),
        );
        const { output } = await first;
        yield {
          type: "finish",
          reason: "stop",
          message: { role: "assistant", parts: [{ type: "text", text: output }] },
          usage: [],
        };
      },
    );
    const generation = generateWith(env as GatewayEnv, conversation, request, session);
    const events = fromNdjsonStream(generation.events())[Symbol.asyncIterator]();
    await events.next();
    const next = events.next();
    await vi.waitFor(() => expect(waits).toHaveLength(2));

    expect(await waits[1]).toMatchObject({ code: "protocol" });
    expect(generation.answer({ callId: "toolu_01", output: "Ana" })).toEqual({ ok: true });
    expect((await next).value).toMatchObject({
      type: "finish",
      message: { parts: [{ type: "text", text: "Ana" }] },
    });
  });
});

describe("the claude-code route (#421)", () => {
  type GatewayEnv = Parameters<typeof generateWith>[0];
  const defaults = () => env.MODEL_DEFAULTS.getByName("instance");
  const owner = { userId: "u-owner", role: "owner", via: "agent:kelpie" } as const;
  const session: RouteSession = {
    conversation: "assistant:telegram:chat-1",
    id: "6c1f2a9e-3b7d-4e51-9a0c-2f8d7e6b5a41",
    resume: true,
    toolLoopMs: 180_000,
  };
  const onClaudeCode = { area: "conversation", agent: { provider: "claude-code" } } as const;
  const encoder = new TextEncoder();
  const line = (frame: unknown) => encoder.encode(`${JSON.stringify(frame)}\n`);

  async function reset(values: Record<string, unknown> = {}) {
    await runInDurableObject(defaults(), (_instance, state) => {
      state.storage.deleteAll();
      for (const [key, value] of Object.entries(values)) state.storage.kv.put(key, value);
    });
  }

  const read = async (stream: ReadableStream<Uint8Array>) => {
    const events: RouterEvent[] = [];
    for await (const event of fromNdjsonStream(stream)) events.push(event);
    return events;
  };

  /**
   * A runner in place of channel-egress's RunnerChat: its turn streams `frames`, and stays open
   * until the call's result comes back, which `after` follows.
   */
  function runner(frames: unknown[], after: unknown[] = []) {
    const turns: { sessionId: string; request: unknown }[] = [];
    const answered: unknown[] = [];
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = 0;
    const client = {
      async turn(sessionId: string, sent: unknown) {
        turns.push({ sessionId, request: sent });
        const events = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            for (const frame of frames) controller.enqueue(line(frame));
            if (after.length === 0) controller.close();
          },
        });
        return {
          ok: true,
          turn: {
            events: () => events,
            cancel: () => {
              cancelled += 1;
            },
          },
        };
      },
      async answer(sessionId: string, result: unknown) {
        answered.push({ sessionId, result });
        for (const frame of after) stream?.enqueue(line(frame));
        stream?.close();
        return { ok: true };
      },
    };
    return { client, turns, answered, cancelled: () => cancelled };
  }

  const finish = {
    type: "finish",
    reason: "stop",
    message: { role: "assistant", parts: [{ type: "text", text: "Ana lives in Porto." }] },
    usage: [],
    session: { id: session.id, clean: true },
  };

  it("follows anthropic in every tier of the committed routes, on the same Claude models (ADR-0037 §1)", () => {
    const routes = parseRouteTable((env as GatewayEnv).MODEL_ROUTES);
    for (const tier of MODEL_TIERS) {
      const providers = routes[tier].map((candidate) => candidate.provider);
      const at = providers.indexOf("anthropic");
      expect(providers[at + 1], tier).toBe("claude-code");
      const api = routes[tier][at]?.model;
      // "haiku" is Kelpie's alias for the newest Claude Haiku: the runner gets a pinned id.
      expect(routes[tier][at + 1]?.model, tier).toBe(api === "haiku" ? "claude-haiku-5-5" : api);
    }
  });

  it("is off until the owner turns it on: no turn reaches it, and no list names it", async () => {
    await reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(
      anthropic(() => sseResponse([start, ...text, ...end])),
    );
    expect(await exports.LlmGatewayAdmin.instanceModels()).toMatchObject({
      providers: ["anthropic"],
      claudeCode: false,
    });
    expect((await exports.LlmGateway.describe("conversation")).route).toEqual([
      { provider: "anthropic", model: "haiku", standsFor: "the newest Claude Haiku" },
    ]);
    // Even a call that names it, with a session, goes to the API route.
    using generation = await exports.LlmChat.generate(onClaudeCode, request, session);
    expect(await read(await generation.events())).toMatchObject([
      { type: "text" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("is turned on and off on the admin entrypoint only, audited like the settings", async () => {
    await reset();
    expect("setClaudeCode" in LlmGateway.prototype).toBe(false);
    expect(await exports.LlmGatewayAdmin.setClaudeCode(true, owner)).toEqual({ ok: true });
    expect(await exports.LlmGatewayAdmin.instanceModels()).toEqual({
      settings: {},
      pinned: null,
      providers: ["anthropic", "claude-code"],
      claudeCode: true,
    });
    expect(await exports.LlmGatewayAdmin.providers()).toEqual(["anthropic", "claude-code"]);
    const long = { ...owner, userId: "u".repeat(500) };
    expect(await exports.LlmGatewayAdmin.setClaudeCode(false, long)).toEqual({ ok: true });
    expect(await exports.LlmGatewayAdmin.setClaudeCode("yes" as never, owner)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await exports.LlmGatewayAdmin.providers()).toEqual(["anthropic"]);
    const audit = await runInDurableObject(defaults(), (_instance, state) =>
      [...state.storage.kv.list({ prefix: "audit:" })].map(([, value]) => value),
    );
    expect(audit).toEqual([
      { at: expect.any(Number), userId: "u-owner", via: "agent:kelpie", claudeCode: true },
      { at: expect.any(Number), userId: "u".repeat(128), via: "agent:kelpie", claudeCode: false },
    ]);
  });

  it("serves only with the switch on and the runner's binding", async () => {
    const { RUNNER_CHAT: _binding, ...unbound } = env as GatewayEnv;
    await reset({ claudeCode: true });
    expect(await providersWith(env as GatewayEnv)).toEqual(["anthropic", "claude-code"]);
    expect(await providersWith(unbound as GatewayEnv)).toEqual(["anthropic"]);
    await reset();
    expect(await providersWith(env as GatewayEnv)).toEqual(["anthropic"]);
  });

  it("describes a conversation's route as its session runs it, after anthropic's, and memory's without it", async () => {
    await reset({ claudeCode: true });
    expect(await exports.LlmGateway.describe("conversation", undefined, "medium")).toEqual({
      provider: "anthropic",
      tier: "medium",
      route: [
        { provider: "anthropic", model: "claude-sonnet-5-5" },
        { provider: "claude-code", model: "claude-sonnet-5-5" },
      ],
    });
    expect((await exports.LlmGateway.describe("memory")).route).toEqual([
      { provider: "anthropic", model: "haiku", standsFor: "the newest Claude Haiku" },
    ]);
    // Calls without a session, as before #286, never list it.
    expect((await exports.LlmGateway.routes()).frontier).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5" },
    ]);
  });

  it("describes memory without it when a scope-wide provider names it (#431)", async () => {
    await reset({ claudeCode: true, instance: { provider: "claude-code" } });
    expect(await exports.LlmGateway.describe("memory")).toEqual({
      provider: "anthropic",
      tier: "cheap",
      route: [{ provider: "anthropic", model: "haiku", standsFor: "the newest Claude Haiku" }],
    });
    expect(await exports.LlmGateway.describe("conversation")).toMatchObject({
      provider: "claude-code",
      route: [{ provider: "claude-code" }, { provider: "anthropic" }],
    });
  });

  it("is never pinned, even when it is the only route that serves", async () => {
    await reset({ claudeCode: true });
    const { ANTHROPIC_API_KEY: _key, ...keyless } = env as GatewayEnv;
    expect(await describeWith(keyless as GatewayEnv, "conversation")).toEqual({
      provider: null,
      tier: "cheap",
      route: [{ provider: "claude-code", model: "claude-haiku-5-5" }],
    });
    await runInDurableObject(defaults(), (_instance, state) => {
      expect(state.storage.kv.get("pinnedProvider")).toBeUndefined();
    });
    // A call that isn't a conversation's has no route at all then.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const memory = generateWith(keyless as GatewayEnv, { area: "memory" }, request);
    await expect(read(memory.events())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reaches channel-egress's RunnerChat over RPC, and falls back when the runner can't take the turn", async () => {
    await reset({ claudeCode: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      anthropic(() => sseResponse([start, ...text, ...end])),
    );
    // The test's channel-egress has no runner connected.
    using generation = await exports.LlmChat.generate(onClaudeCode, request, session);
    expect(await read(await generation.events())).toMatchObject([
      {
        type: "fallback",
        failed: { provider: "claude-code", model: "claude-haiku-5-5", code: "unavailable" },
        next: { provider: "anthropic", model: "haiku" },
      },
      { type: "text", delta: "Olá!" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("runs a turn on the runner, with the session's bound, and gives it the call's result", async () => {
    await reset({ claudeCode: true });
    const call = { type: "tool_call", id: "toolu_01", name: "search_memory", input: { q: "Ana" } };
    const fake = runner(
      [
        { type: "ping" },
        {
          type: "round",
          message: { role: "assistant", parts: [{ ...call, name: "mcp__kelpie__search_memory" }] },
          usage: [],
        },
        { type: "tool_call", call },
      ],
      [finish],
    );
    const withRunner = {
      ...(env as GatewayEnv),
      RUNNER_CHAT: fake.client,
    } as unknown as GatewayEnv;
    const generation = generateWith(
      withRunner,
      onClaudeCode,
      {
        ...request,
        tools: [{ name: "search_memory", description: "x", inputSchema: { type: "object" } }],
      },
      session,
    );
    const events = fromNdjsonStream(generation.events())[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({
      type: "tool_round",
      message: { parts: [call] },
    });
    expect((await events.next()).value).toEqual({ type: "tool_request", call });
    expect(generation.answer({ callId: "toolu_01", output: "Ana lives in Porto." })).toEqual({
      ok: true,
    });
    expect((await events.next()).value).toEqual({
      ...finish,
      message: { role: "assistant", parts: [{ type: "text", text: "Ana lives in Porto." }] },
    });
    expect((await events.next()).done).toBe(true);
    expect(fake.turns).toEqual([
      {
        sessionId: session.id,
        request: expect.objectContaining({
          conversation: session.conversation,
          resume: true,
          model: "claude-haiku-5-5",
          toolLoopMs: 180_000,
          messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
        }),
      },
    ]);
    expect(fake.answered).toEqual([
      { sessionId: session.id, result: { callId: "toolu_01", output: "Ana lives in Porto." } },
    ]);
    expect(fake.cancelled()).toBe(1);
  });

  it("keeps it out of memory, and refuses it while it is off, for the instance's settings", async () => {
    await reset();
    const refused = { ok: false, reason: "invalid_input" };
    const conversationOn = { conversation: { provider: "claude-code" } } as const;
    expect(await exports.LlmGatewayAdmin.configureDefaults(conversationOn, owner)).toEqual(refused);
    await exports.LlmGatewayAdmin.setClaudeCode(true, owner);
    expect(await exports.LlmGatewayAdmin.configureDefaults(conversationOn, owner)).toEqual({
      ok: true,
    });
    expect(
      await exports.LlmGatewayAdmin.configureDefaults(
        { memory: { provider: "claude-code" } },
        owner,
      ),
    ).toEqual(refused);
    expect((await exports.LlmGatewayAdmin.instanceModels()).settings).toEqual(conversationOn);
  });
});
