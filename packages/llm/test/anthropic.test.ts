import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesProvider, type ResolvedAlias } from "../src/anthropic.ts";
import { LlmError } from "../src/errors.ts";
import type { ChatMessage, LlmEvent, LlmRequest } from "../src/types.ts";
import { collect, fakeFetch, hangingSse, httpError, json, requestAt, sse } from "./fake-fetch.ts";

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/account/kelpie/anthropic";

function provider(fetchFn: typeof fetch) {
  return new AnthropicMessagesProvider({
    apiKey: "sk-ant-test",
    baseURL: GATEWAY,
    headers: { "cf-aig-authorization": "Bearer gateway-token" },
    fetch: fetchFn,
  });
}

const weatherTool = {
  name: "get_weather",
  description: "Current weather for a city",
  inputSchema: { type: "object" as const, properties: { city: { type: "string" } } },
};

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "claude-opus-5-5",
    system: "You are Kelpie.",
    messages: [{ role: "user", parts: [{ type: "text", text: "Weather in Lisbon?" }] }],
    tools: [weatherTool],
    maxOutputTokens: 4096,
    ...overrides,
  };
}

function messageStart(model: string, usage: Record<string, number>) {
  return {
    type: "message_start",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { output_tokens: 1, ...usage },
    },
  };
}

function messageEnd(stopReason: string, usage: Record<string, unknown> = { output_tokens: 85 }) {
  return [
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage },
    { type: "message_stop" },
  ];
}

function textBlock(index: number, ...deltas: string[]) {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...deltas.map((text) => ({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    })),
    { type: "content_block_stop", index },
  ];
}

function thinkingBlock(index: number, signature: string) {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
    { type: "content_block_stop", index },
  ];
}

function toolUseBlock(index: number, id: string, json: string) {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name: "get_weather", input: {} },
    },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } },
    { type: "content_block_stop", index },
  ];
}

const toolTurn = [
  messageStart("claude-opus-5-5", {
    input_tokens: 120,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 5000,
  }),
  ...thinkingBlock(0, "sig-abc"),
  ...textBlock(1, "Let me check ", "the weather."),
  ...toolUseBlock(2, "toolu_01", '{"city":"Lisbon"}'),
  ...messageEnd("tool_use"),
];

function finishOf(events: LlmEvent[]) {
  const finish = events.at(-1);
  if (finish?.type !== "finish") throw new Error("stream did not finish");
  return finish;
}

describe("AnthropicMessagesProvider", () => {
  it("replays its own reply verbatim on the next turn", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn), sse(toolTurn));
    const llm = provider(fetch);

    const first = finishOf(await collect(llm.stream(request())));
    const history: ChatMessage[] = [
      ...request().messages,
      first.message,
      { role: "tool", results: [{ callId: "toolu_01", output: "18°C, sunny" }] },
    ];
    await collect(llm.stream(request({ messages: history })));

    const replayed = (requestAt(calls, 1).body.messages as { role: string; content: unknown }[])[1];
    expect(replayed).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-abc" },
        { type: "text", text: "Let me check the weather." },
        { type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "Lisbon" } },
      ],
    });
    expect(replayed?.content).toEqual(first.message.native?.content);
  });

  it("streams text and finishes with neutral parts, native content and usage", async () => {
    const { fetch } = fakeFetch(sse(toolTurn));
    const events = await collect(provider(fetch).stream(request()));

    expect(events.slice(0, 2)).toEqual([
      { type: "text", delta: "Let me check " },
      { type: "text", delta: "the weather." },
    ]);
    const finish = finishOf(events);
    expect(finish.reason).toBe("tool_calls");
    expect(finish.message.parts).toEqual([
      { type: "text", text: "Let me check the weather." },
      { type: "tool_call", id: "toolu_01", name: "get_weather", input: { city: "Lisbon" } },
    ]);
    expect(finish.message.native).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    // Cache reads and writes are reported on top of input_tokens, so they pass through as they are.
    expect(finish.usage).toEqual([
      {
        model: "claude-opus-5-5",
        inputUncached: 120,
        cacheRead: 5000,
        cacheWrite: 2000,
        output: 85,
      },
    ]);
  });

  it("sends the request through the gateway with caching and refusal fallback", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    await collect(provider(fetch).stream(request({ effort: "low" })));

    const call = requestAt(calls, 0);
    // The SDK marks calls through `client.beta` with a query parameter.
    expect(call.url).toBe(`${GATEWAY}/v1/messages?beta=true`);
    expect(call.headers.get("x-api-key")).toBe("sk-ant-test");
    expect(call.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(call.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(call.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      system: "You are Kelpie.",
      stream: true,
      cache_control: { type: "ephemeral" },
      fallbacks: "default",
      output_config: { effort: "low" },
      tools: [
        {
          name: "get_weather",
          description: "Current weather for a city",
          input_schema: weatherTool.inputSchema,
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "Weather in Lisbon?" }] }],
    });
    for (const absent of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "betas"]) {
      expect(call.body).not.toHaveProperty(absent);
    }
  });

  it("sends a request's context after the conversation, and caches the conversation without it", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn), sse(toolTurn));
    const context = "<memory>Ana mora em Lisboa.</memory>";
    await collect(provider(fetch).stream(request({ context })));

    const body = requestAt(calls, 0).body;
    // The breakpoint sits before the context, so the cache covers what came before it.
    expect(body).not.toHaveProperty("cache_control");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Weather in Lisbon?", cache_control: { type: "ephemeral" } },
          { type: "text", text: context },
        ],
      },
    ]);

    // After a reply, there is no user turn to join: the context comes as one, and the breakpoint
    // goes on the reply's last block that can carry one.
    const messages: ChatMessage[] = [
      ...request().messages,
      { role: "assistant", parts: [{ type: "text", text: "Sunny." }] },
    ];
    await collect(provider(fetch).stream(request({ messages, context })));
    expect(requestAt(calls, 1).body).not.toHaveProperty("cache_control");
    expect((requestAt(calls, 1).body.messages as unknown[]).slice(1)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Sunny.", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: [{ type: "text", text: context }] },
    ]);
  });

  it("sends a context again, as part of its message, exactly as it first went", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn), sse(toolTurn));
    const context = "<memory>Ana mora em Lisboa.</memory>";
    await collect(provider(fetch).stream(request({ context })));
    const later: ChatMessage[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "Weather in Lisbon?" },
          { type: "text", text: context },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "Sunny." }] },
      { role: "user", parts: [{ type: "text", text: "And Porto?" }] },
    ];
    await collect(provider(fetch).stream(request({ messages: later })));
    // Breakpoints aside, the first turn is the same in both requests.
    const plain = (body: Record<string, unknown>) =>
      JSON.parse(
        JSON.stringify((body.messages as unknown[])[0]).replaceAll(
          ',"cache_control":{"type":"ephemeral"}',
          "",
        ),
      );
    expect(plain(requestAt(calls, 1).body)).toEqual(plain(requestAt(calls, 0).body));
  });

  it("puts the breakpoint on the last tool result, and leaves the turns before it alone", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn), sse(toolTurn));
    const messages: ChatMessage[] = [
      ...request().messages,
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "toolu_01", name: "get_weather", input: { city: "Lisbon" } },
          { type: "tool_call", id: "toolu_02", name: "get_weather", input: { city: "Porto" } },
        ],
      },
      {
        role: "tool",
        results: [
          { callId: "toolu_01", output: "18°C" },
          { callId: "toolu_02", output: "16°C" },
        ],
      },
    ];
    await collect(provider(fetch).stream(request({ messages })));
    await collect(provider(fetch).stream(request({ messages, context: "<memory/>" })));

    const plain = requestAt(calls, 0).body.messages as unknown[];
    const sent = requestAt(calls, 1).body.messages as unknown[];
    expect(sent.slice(0, 2)).toEqual(plain.slice(0, 2));
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "18°C" },
        {
          type: "tool_result",
          tool_use_id: "toolu_02",
          content: "16°C",
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: "<memory/>" },
      ],
    });
  });

  it("sends a blank context as no context", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn), sse(toolTurn));
    await collect(provider(fetch).stream(request()));
    await collect(provider(fetch).stream(request({ context: " \n" })));
    expect(requestAt(calls, 1).body).toEqual(requestAt(calls, 0).body);
  });

  it("sends neither effort nor refusal fallback to Claude Haiku 4.5", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    await collect(provider(fetch).stream(request({ model: "claude-haiku-4-5" })));

    expect(requestAt(calls, 0).body).not.toHaveProperty("fallbacks");
    expect(requestAt(calls, 0).body).not.toHaveProperty("output_config");
    expect(requestAt(calls, 0).headers.has("anthropic-beta")).toBe(false);
  });

  it("replays a reply kept without its native output as neutral text", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Tell me about Lisbon" }] },
      { role: "assistant", parts: [{ type: "text", text: "Lisbon is the capital." }] },
      { role: "user", parts: [{ type: "text", text: "And Porto?" }] },
    ];
    await collect(provider(fetch).stream(request({ messages })));

    expect((requestAt(calls, 0).body.messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Lisbon is the capital." }],
    });
  });

  it("maps tool results and replies from another provider", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Weather in Lisbon?" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "" },
          { type: "tool_call", id: "call_9", name: "get_weather", input: { city: "Lisbon" } },
        ],
        native: { provider: "openai", model: "gpt-6.1-sol", content: [{ type: "reasoning" }] },
      },
      { role: "tool", results: [{ callId: "call_9", output: "timeout", isError: true }] },
    ];
    await collect(provider(fetch).stream(request({ messages })));

    expect((requestAt(calls, 0).body.messages as unknown[]).slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_9", name: "get_weather", input: { city: "Lisbon" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_9", content: "timeout", is_error: true },
        ],
      },
    ]);
  });

  it("drops the declined partial's thinking and tool calls after a mid-output fallback", async () => {
    const { fetch } = fakeFetch(
      sse([
        messageStart("claude-opus-5-5", { input_tokens: 50 }),
        ...thinkingBlock(0, "sig-declined"),
        ...textBlock(1, "Partial answer. "),
        ...toolUseBlock(2, "toolu_never_ran", '{"city":"Lisbon"}'),
        {
          type: "content_block_start",
          index: 3,
          content_block: {
            type: "fallback",
            from: { model: "claude-opus-5-5" },
            to: { model: "claude-opus-5" },
            trigger: { type: "refusal", category: "cyber" },
          },
        },
        { type: "content_block_stop", index: 3 },
        ...thinkingBlock(4, "sig-served"),
        ...textBlock(5, "Full answer."),
        ...messageEnd("end_turn", {
          output_tokens: 30,
          iterations: [
            {
              type: "message",
              model: null,
              input_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 400,
              output_tokens: 12,
              cache_creation: null,
            },
            {
              type: "fallback_message",
              model: "claude-opus-5",
              input_tokens: 60,
              cache_creation_input_tokens: 450,
              cache_read_input_tokens: 0,
              output_tokens: 30,
              cache_creation: null,
            },
          ],
        }),
      ]),
    );
    const finish = finishOf(await collect(provider(fetch).stream(request())));

    expect(finish.reason).toBe("stop");
    expect(finish.message.native?.content.map((block) => (block as { type: string }).type)).toEqual(
      ["text", "fallback", "thinking", "text"],
    );
    expect(finish.message.parts).toEqual([
      { type: "text", text: "Partial answer. " },
      { type: "text", text: "Full answer." },
    ]);
    // Each attempt is billed at its own model's price; the declined one is the requested model.
    expect(finish.usage).toEqual([
      { model: "claude-opus-5-5", inputUncached: 50, cacheRead: 400, cacheWrite: 0, output: 12 },
      { model: "claude-opus-5", inputUncached: 60, cacheRead: 0, cacheWrite: 450, output: 30 },
    ]);
  });

  it("reports length and leaves the truncated tool call out of the replayed turn", async () => {
    const { fetch, calls } = fakeFetch(
      sse([
        messageStart("claude-opus-5-5", { input_tokens: 10 }),
        ...thinkingBlock(0, "sig-abc"),
        ...textBlock(1, "Checking."),
        ...toolUseBlock(2, "toolu_02", '{"ci'),
        ...messageEnd("max_tokens"),
      ]),
      sse(toolTurn),
    );
    const llm = provider(fetch);
    const finish = finishOf(await collect(llm.stream(request())));

    expect(finish.reason).toBe("length");
    expect(finish.message.parts).toEqual([{ type: "text", text: "Checking." }]);

    // A tool_use without a tool_result in the next turn would be rejected.
    const history: ChatMessage[] = [
      ...request().messages,
      finish.message,
      { role: "user", parts: [{ type: "text", text: "Go on" }] },
    ];
    await collect(llm.stream(request({ messages: history })));
    expect((requestAt(calls, 1).body.messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-abc" },
        { type: "text", text: "Checking." },
      ],
    });
  });

  it("reports a refusal and leaves the empty turn out of the next request", async () => {
    const { fetch, calls } = fakeFetch(
      sse([messageStart("claude-opus-5-5", { input_tokens: 10 }), ...messageEnd("refusal")]),
      sse(toolTurn),
    );
    const llm = provider(fetch);
    const finish = finishOf(await collect(llm.stream(request())));

    expect(finish.reason).toBe("refusal");
    expect(finish.message.parts).toEqual([]);

    const history: ChatMessage[] = [
      ...request().messages,
      finish.message,
      { role: "user", parts: [{ type: "text", text: "Another question" }] },
    ];
    await collect(llm.stream(request({ messages: history })));
    expect(
      (requestAt(calls, 1).body.messages as { role: string }[]).map((message) => message.role),
    ).toEqual(["user", "user"]);
  });

  it.each([
    ["overloaded_error", "server_error", true],
    ["invalid_request_error", "bad_request", false],
  ])("classifies an in-stream %s", async (kind, code, retryable) => {
    const { fetch } = fakeFetch(
      sse([
        messageStart("claude-opus-5-5", { input_tokens: 10 }),
        { type: "error", error: { type: kind, message: "stream failed" } },
      ]),
    );

    await expect(collect(provider(fetch).stream(request()))).rejects.toMatchObject({
      code,
      retryable,
    });
  });

  it("rejects a stop reason Kelpie never asks for", async () => {
    const { fetch } = fakeFetch(
      sse([messageStart("claude-opus-5-5", { input_tokens: 10 }), ...messageEnd("pause_turn")]),
    );
    await expect(collect(provider(fetch).stream(request()))).rejects.toMatchObject({
      code: "protocol",
      retryable: false,
    });
  });

  it.each([
    [429, "rate_limited", true],
    [529, "server_error", true],
    [401, "auth", false],
    [400, "bad_request", false],
  ])("classifies HTTP %i as %s", async (status, code, retryable) => {
    const { fetch } = fakeFetch(
      httpError(status, { type: "error", error: { type: "some_error", message: "nope" } }),
    );
    const failure = collect(provider(fetch).stream(request()));

    await expect(failure).rejects.toBeInstanceOf(LlmError);
    await expect(failure).rejects.toMatchObject({ code, retryable });
  });

  it("stops the request when the caller aborts", async () => {
    const { fetch } = fakeFetch(
      hangingSse([messageStart("claude-opus-5-5", { input_tokens: 10 }), ...textBlock(0, "Hi")]),
    );
    const controller = new AbortController();
    const seen: LlmEvent[] = [];
    const run = (async () => {
      for await (const event of provider(fetch).stream(request(), { signal: controller.signal })) {
        seen.push(event);
        controller.abort();
      }
    })();

    await expect(run).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(seen).toEqual([{ type: "text", delta: "Hi" }]);
  });
});

describe("the haiku alias", () => {
  // Pages in the Models API's documented format (`GET /v1/models`), not recorded.
  function modelsPage(models: [id: string, createdAt: string][], hasMore = false) {
    return json({
      data: models.map(([id, created_at]) => ({
        type: "model",
        id,
        display_name: id,
        created_at,
        max_input_tokens: 200_000,
        max_tokens: 64_000,
        capabilities: null,
      })),
      has_more: hasMore,
      first_id: models[0]?.[0] ?? null,
      last_id: models.at(-1)?.[0] ?? null,
    });
  }

  const catalog: [string, string][] = [
    ["claude-sonnet-5-5", "2026-09-30T00:00:00Z"],
    ["claude-haiku-5-5", "2026-09-15T00:00:00Z"],
    ["claude-haiku-4-5-20251001", "2025-10-01T00:00:00Z"],
    ["claude-3-5-haiku-20241022", "2024-10-22T00:00:00Z"],
  ];

  const haikuTurn = [
    messageStart("claude-haiku-5-5", { input_tokens: 10 }),
    ...textBlock(0, "Hi"),
    ...messageEnd("end_turn", { output_tokens: 2 }),
  ];

  // The gateway builds a provider for every call, so each test passes the cache they share.
  function aliased(fetchFn: typeof fetch, aliasCache = new Map<string, ResolvedAlias>()) {
    return new AnthropicMessagesProvider({
      apiKey: "sk-ant-test",
      baseURL: GATEWAY,
      fetch: fetchFn,
      aliasCache,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends and reports the newest Claude Haiku the Models API lists", async () => {
    const { fetch, calls } = fakeFetch(modelsPage(catalog), sse(haikuTurn));
    const events = await collect(aliased(fetch).stream(request({ model: "haiku" })));

    expect(requestAt(calls, 0).url).toBe(`${GATEWAY}/v1/models?limit=1000`);
    expect(requestAt(calls, 0).headers.get("x-api-key")).toBe("sk-ant-test");
    expect(requestAt(calls, 1).body).toMatchObject({ model: "claude-haiku-5-5" });
    expect(finishOf(events).usage).toEqual([
      expect.objectContaining({ model: "claude-haiku-5-5" }),
    ]);
  });

  it("goes by release date, not by the list's order, across pages", async () => {
    const { fetch, calls } = fakeFetch(
      modelsPage(
        [
          ["claude-haiku-4-5-20251001", "2025-10-01T00:00:00Z"],
          ["claude-opus-5-5", "2026-09-01T00:00:00Z"],
        ],
        true,
      ),
      modelsPage([["claude-haiku-5-5", "2026-09-15T00:00:00Z"]]),
      sse(haikuTurn),
    );
    await collect(aliased(fetch).stream(request({ model: "haiku" })));

    expect(requestAt(calls, 1).url).toBe(
      `${GATEWAY}/v1/models?limit=1000&after_id=claude-opus-5-5`,
    );
    expect(requestAt(calls, 2).body).toMatchObject({ model: "claude-haiku-5-5" });
  });

  it("asks the Models API again only after an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const cache = new Map<string, ResolvedAlias>();
    const { fetch, calls } = fakeFetch(
      modelsPage(catalog),
      sse(haikuTurn),
      sse(haikuTurn),
      modelsPage(catalog),
      sse(haikuTurn),
    );

    await collect(aliased(fetch, cache).stream(request({ model: "haiku" })));
    vi.setSystemTime(new Date("2026-10-08T12:59:00Z"));
    await collect(aliased(fetch, cache).stream(request({ model: "haiku" })));
    vi.setSystemTime(new Date("2026-10-08T13:01:00Z"));
    await collect(aliased(fetch, cache).stream(request({ model: "haiku" })));

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/account/kelpie/anthropic/v1/models",
      "/v1/account/kelpie/anthropic/v1/messages",
      "/v1/account/kelpie/anthropic/v1/messages",
      "/v1/account/kelpie/anthropic/v1/models",
      "/v1/account/kelpie/anthropic/v1/messages",
    ]);
  });

  it.each([
    [
      "a refused models call",
      httpError(404, { type: "error", error: { type: "not_found_error" } }),
    ],
    ["a server error", httpError(500, { type: "error", error: { type: "api_error" } })],
    ["a list without a Haiku", modelsPage([["claude-opus-5-5", "2026-09-01T00:00:00Z"]])],
  ])("lets the router try the next candidate after %s", async (_case, response) => {
    const { fetch, calls } = fakeFetch(response);
    const failure = collect(aliased(fetch).stream(request({ model: "haiku" })));

    await expect(failure).rejects.toBeInstanceOf(LlmError);
    await expect(failure).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect(calls).toHaveLength(1);
  });

  it("stops when the caller aborts while the models are listed", async () => {
    const { fetch } = fakeFetch((signal) => {
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      throw new Error("the request should have been aborted");
    });
    const controller = new AbortController();
    controller.abort();
    const failure = collect(
      aliased(fetch).stream(request({ model: "haiku" }), { signal: controller.signal }),
    );

    await expect(failure).rejects.toMatchObject({ code: "aborted", retryable: false });
  });
});
