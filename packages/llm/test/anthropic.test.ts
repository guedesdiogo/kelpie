import { describe, expect, it } from "vitest";
import { AnthropicMessagesProvider } from "../src/anthropic.ts";
import { LlmError } from "../src/errors.ts";
import type { ChatMessage, LlmEvent, LlmRequest } from "../src/types.ts";
import { collect, fakeFetch, hangingSse, httpError, requestAt, sse } from "./fake-fetch.ts";

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
    expect(replayed?.content).toEqual(first.message.native.content);
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

  it("sends neither effort nor refusal fallback to Claude Haiku 4.5", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    await collect(provider(fetch).stream(request({ model: "claude-haiku-4-5" })));

    expect(requestAt(calls, 0).body).not.toHaveProperty("fallbacks");
    expect(requestAt(calls, 0).body).not.toHaveProperty("output_config");
    expect(requestAt(calls, 0).headers.has("anthropic-beta")).toBe(false);
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
    expect(finish.message.native.content.map((block) => (block as { type: string }).type)).toEqual([
      "text",
      "fallback",
      "thinking",
      "text",
    ]);
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

  it("reports length and leaves out the truncated tool call", async () => {
    const { fetch } = fakeFetch(
      sse([
        messageStart("claude-opus-5-5", { input_tokens: 10 }),
        ...textBlock(0, "Checking."),
        ...toolUseBlock(1, "toolu_02", '{"ci'),
        ...messageEnd("max_tokens"),
      ]),
    );
    const finish = finishOf(await collect(provider(fetch).stream(request())));

    expect(finish.reason).toBe("length");
    expect(finish.message.parts).toEqual([{ type: "text", text: "Checking." }]);
  });

  it("reports a refusal", async () => {
    const { fetch } = fakeFetch(
      sse([messageStart("claude-opus-5-5", { input_tokens: 10 }), ...messageEnd("refusal")]),
    );
    const finish = finishOf(await collect(provider(fetch).stream(request())));

    expect(finish.reason).toBe("refusal");
    expect(finish.message.parts).toEqual([]);
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
