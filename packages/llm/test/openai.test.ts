import { describe, expect, it } from "vitest";
import { LlmError } from "../src/errors.ts";
import { OpenAIResponsesProvider } from "../src/openai.ts";
import type { ChatMessage, LlmEvent, LlmRequest } from "../src/types.ts";
import { collect, fakeFetch, hangingSse, httpError, requestAt, sse } from "./fake-fetch.ts";

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/account/kelpie/openai";

function provider(fetchFn: typeof fetch) {
  return new OpenAIResponsesProvider({
    apiKey: "sk-openai-test",
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
    model: "gpt-6.1-sol",
    system: "You are Kelpie.",
    messages: [{ role: "user", parts: [{ type: "text", text: "Weather in Lisbon?" }] }],
    tools: [weatherTool],
    maxOutputTokens: 4096,
    ...overrides,
  };
}

const reasoningItem = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  encrypted_content: "gAAAAB-encrypted",
};
const messageItem = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Let me check the weather.", annotations: [] }],
};
const functionCallItem = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "get_weather",
  arguments: '{"city":"Lisbon"}',
  status: "completed",
};

interface Final {
  status: "completed" | "incomplete" | "failed";
  output: Record<string, unknown>[];
  incomplete_details?: { reason: string };
  error?: { code: string; message: string };
}

const usage = {
  input_tokens: 9000,
  input_tokens_details: { cached_tokens: 6000, cache_write_tokens: 2500 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 200 },
  total_tokens: 9300,
};

/** The event sequence of a streamed response, built from the response it ends with. */
function responseEvents(final: Final) {
  let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>) => ({
    type,
    sequence_number: sequence++,
    ...fields,
  });
  const response = {
    id: "resp_1",
    object: "response",
    model: "gpt-6.1-sol",
    incomplete_details: null,
    error: null,
    usage,
    ...final,
  };
  const events = [
    event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
  ];
  final.output.forEach((item, index) => {
    events.push(event("response.output_item.added", { output_index: index, item }));
    if (item === messageItem) {
      for (const delta of ["Let me check ", "the weather."]) {
        events.push(
          event("response.output_text.delta", {
            item_id: "msg_1",
            output_index: index,
            content_index: 0,
            delta,
            logprobs: [],
          }),
        );
      }
    }
    events.push(event("response.output_item.done", { output_index: index, item }));
  });
  events.push(event(`response.${final.status}`, { response }));
  return events;
}

const toolTurn = responseEvents({
  status: "completed",
  output: [reasoningItem, messageItem, functionCallItem],
});

function finishOf(events: LlmEvent[]) {
  const finish = events.at(-1);
  if (finish?.type !== "finish") throw new Error("stream did not finish");
  return finish;
}

describe("OpenAIResponsesProvider", () => {
  it("replays its own output items verbatim on the next turn", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn), sse(toolTurn));
    const llm = provider(fetch);

    const first = finishOf(await collect(llm.stream(request())));
    const history: ChatMessage[] = [
      ...request().messages,
      first.message,
      { role: "tool", results: [{ callId: "call_1", output: "18°C, sunny" }] },
    ];
    await collect(llm.stream(request({ messages: history })));

    expect(requestAt(calls, 1).body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Weather in Lisbon?" }],
      },
      reasoningItem,
      messageItem,
      functionCallItem,
      { type: "function_call_output", call_id: "call_1", output: "18°C, sunny" },
    ]);
  });

  it("streams text and finishes with neutral parts, native output and usage", async () => {
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
      { type: "tool_call", id: "call_1", name: "get_weather", input: { city: "Lisbon" } },
    ]);
    expect(finish.message.native).toEqual({
      provider: "openai",
      model: "gpt-6.1-sol",
      content: [reasoningItem, messageItem, functionCallItem],
    });
    // Cache reads and writes are counted inside input_tokens, so they come out of the uncached count.
    expect(finish.usage).toEqual([
      { model: "gpt-6.1-sol", inputUncached: 500, cacheRead: 6000, cacheWrite: 2500, output: 300 },
    ]);
  });

  it("sends a stateless request through the gateway", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    await collect(provider(fetch).stream(request({ effort: "medium" })));

    const call = requestAt(calls, 0);
    expect(call.url).toBe(`${GATEWAY}/responses`);
    expect(call.headers.get("authorization")).toBe("Bearer sk-openai-test");
    expect(call.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(call.body).toEqual({
      model: "gpt-6.1-sol",
      instructions: "You are Kelpie.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Weather in Lisbon?" }],
        },
      ],
      max_output_tokens: 4096,
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Current weather for a city",
          parameters: weatherTool.inputSchema,
          strict: false,
        },
      ],
      reasoning: { effort: "medium" },
      stream: true,
    });
  });

  it("sends a request's context as a last user message, after the conversation", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    const context = "<memory>Ana mora em Lisboa.</memory>";
    await collect(provider(fetch).stream(request({ context })));

    expect(requestAt(calls, 0).body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Weather in Lisbon?" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: context }] },
    ]);
  });

  it("sends a blank context as no context", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn), sse(toolTurn));
    await collect(provider(fetch).stream(request()));
    await collect(provider(fetch).stream(request({ context: " \n" })));
    expect(requestAt(calls, 1).body).toEqual(requestAt(calls, 0).body);
  });

  it("replays a reply kept without its native output as neutral text", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Tell me about Lisbon" }] },
      { role: "assistant", parts: [{ type: "text", text: "Lisbon is the capital." }] },
    ];
    await collect(provider(fetch).stream(request({ messages })));

    expect((requestAt(calls, 0).body.input as unknown[])[1]).toEqual({
      role: "assistant",
      content: "Lisbon is the capital.",
    });
  });

  it("rebuilds a reply from another provider without its reasoning", async () => {
    const { fetch, calls } = fakeFetch(sse(toolTurn));
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Weather in Lisbon?" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Checking." },
          { type: "tool_call", id: "toolu_01", name: "get_weather", input: { city: "Lisbon" } },
        ],
        native: {
          provider: "anthropic",
          model: "claude-opus-5-5",
          content: [{ type: "thinking", thinking: "", signature: "sig" }],
        },
      },
      { role: "tool", results: [{ callId: "toolu_01", output: "18°C" }] },
    ];
    await collect(provider(fetch).stream(request({ messages })));

    expect((requestAt(calls, 0).body.input as unknown[]).slice(1)).toEqual([
      { role: "assistant", content: "Checking." },
      {
        type: "function_call",
        call_id: "toolu_01",
        name: "get_weather",
        arguments: '{"city":"Lisbon"}',
      },
      { type: "function_call_output", call_id: "toolu_01", output: "18°C" },
    ]);
  });

  it("reports length and leaves out the truncated function call", async () => {
    const truncated = { ...functionCallItem, arguments: '{"ci', status: "incomplete" };
    const { fetch } = fakeFetch(
      sse(
        responseEvents({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [messageItem, truncated],
        }),
      ),
    );
    const finish = finishOf(await collect(provider(fetch).stream(request())));

    expect(finish.reason).toBe("length");
    expect(finish.message.parts).toEqual([{ type: "text", text: "Let me check the weather." }]);
    // A function call without its output in the next turn would be rejected.
    expect(finish.message.native?.content).toEqual([messageItem]);
  });

  it.each([
    ["server_error", "server_error", true],
    ["invalid_prompt", "bad_request", false],
  ])("classifies an in-stream %s error event", async (errorCode, code, retryable) => {
    const { fetch } = fakeFetch(
      sse([
        toolTurn[0] as { type: string },
        {
          type: "error",
          code: errorCode,
          message: "stream failed",
          param: null,
          sequence_number: 1,
        },
      ]),
    );

    await expect(collect(provider(fetch).stream(request()))).rejects.toMatchObject({
      code,
      retryable,
    });
  });

  it("reports a refusal and keeps its text out of the parts", async () => {
    const refusal = {
      ...messageItem,
      content: [{ type: "refusal", refusal: "I can't help with that." }],
    };
    const { fetch } = fakeFetch(sse(responseEvents({ status: "completed", output: [refusal] })));
    const finish = finishOf(await collect(provider(fetch).stream(request())));

    expect(finish.reason).toBe("refusal");
    expect(finish.message.parts).toEqual([]);
  });

  it("classifies a failed response", async () => {
    const { fetch } = fakeFetch(
      sse(
        responseEvents({
          status: "failed",
          output: [],
          error: { code: "server_error", message: "boom" },
        }),
      ),
    );
    await expect(collect(provider(fetch).stream(request()))).rejects.toMatchObject({
      code: "server_error",
      retryable: true,
    });
  });

  it("fails when the stream ends without a final response", async () => {
    const { fetch } = fakeFetch(sse(toolTurn.slice(0, -1)));
    await expect(collect(provider(fetch).stream(request()))).rejects.toMatchObject({
      code: "connection",
      retryable: true,
    });
  });

  it.each([
    [429, "rate_limited", true],
    [503, "server_error", true],
    [401, "auth", false],
    [400, "bad_request", false],
  ])("classifies HTTP %i as %s", async (status, code, retryable) => {
    const { fetch } = fakeFetch(httpError(status, { error: { message: "nope", type: "x" } }));
    const failure = collect(provider(fetch).stream(request()));

    await expect(failure).rejects.toBeInstanceOf(LlmError);
    await expect(failure).rejects.toMatchObject({ code, retryable });
  });

  it("stops the request when the caller aborts", async () => {
    const { fetch } = fakeFetch(hangingSse(toolTurn.slice(0, 5)));
    const controller = new AbortController();
    const seen: LlmEvent[] = [];
    const run = (async () => {
      for await (const event of provider(fetch).stream(request(), { signal: controller.signal })) {
        seen.push(event);
        controller.abort();
      }
    })();

    await expect(run).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(seen).toEqual([{ type: "text", delta: "Let me check " }]);
  });
});
