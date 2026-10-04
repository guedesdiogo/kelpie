import { describe, expect, it } from "vitest";
import { OpenAIResponsesProvider } from "../src/openai.ts";
import type { ChatMessage, LlmEvent, LlmRequest } from "../src/types.ts";
import { collect, fakeFetch, requestAt } from "./fake-fetch.ts";
import turnOne from "./recorded/openai-turn-1.sse?raw";
import turnTwo from "./recorded/openai-turn-2.sse?raw";

// Streams recorded from the live Responses API by the manual smoke test (#57): gpt-6.1-sol,
// 2026-10-04, called directly rather than through AI Gateway. Bodies only, no headers. The
// hand-built fixtures in openai.test.ts still cover what a short call doesn't show: reasoning
// items, truncation, refusals and failures.

const recorded = (body: string) => () =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });

const request: LlmRequest = {
  model: "gpt-6.1-sol",
  system: "You are a test assistant. Always use the get_weather tool for weather questions.",
  messages: [{ role: "user", parts: [{ type: "text", text: "What's the weather in Lisbon?" }] }],
  tools: [
    {
      name: "get_weather",
      description: "Current weather for a city",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
  maxOutputTokens: 2048,
};

function provider(fetchFn: typeof fetch) {
  return new OpenAIResponsesProvider({ apiKey: "sk-openai-test", fetch: fetchFn });
}

function finishOf(events: LlmEvent[]) {
  const finish = events.at(-1);
  if (finish?.type !== "finish") throw new Error("stream did not finish");
  return finish;
}

describe("OpenAIResponsesProvider against recorded streams", () => {
  it("reads a recorded tool call, its native item and its usage", async () => {
    const { fetch } = fakeFetch(recorded(turnOne));
    const finish = finishOf(await collect(provider(fetch).stream(request)));

    expect(finish.reason).toBe("tool_calls");
    expect(finish.message.parts).toEqual([
      {
        type: "tool_call",
        id: "call_wBKOSbUjPSBA38m8jWknFaOc",
        name: "get_weather",
        input: { city: "Lisbon" },
      },
    ]);
    expect(finish.message.native).toMatchObject({
      provider: "openai",
      model: "gpt-6.1-sol",
      content: [
        {
          type: "function_call",
          id: "fc_0a1c987d928e20b0016ac1de0f707087d29829b4baea552c5b",
          call_id: "call_wBKOSbUjPSBA38m8jWknFaOc",
        },
      ],
    });
    expect(finish.usage).toEqual([
      { model: "gpt-6.1-sol", inputUncached: 70, cacheRead: 0, cacheWrite: 0, output: 19 },
    ]);
  });

  it("replays the recorded item verbatim and reads the recorded answer", async () => {
    const { fetch, calls } = fakeFetch(recorded(turnOne), recorded(turnTwo));
    const llm = provider(fetch);
    const first = finishOf(await collect(llm.stream(request)));
    const history: ChatMessage[] = [
      ...request.messages,
      first.message,
      {
        role: "tool",
        results: [{ callId: "call_wBKOSbUjPSBA38m8jWknFaOc", output: "18°C, sunny" }],
      },
    ];
    const events = await collect(llm.stream({ ...request, messages: history }));

    // The live API accepted exactly this input on the second turn.
    expect(requestAt(calls, 1).body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "What's the weather in Lisbon?" }],
      },
      ...(first.message.native?.content as unknown[]),
      {
        type: "function_call_output",
        call_id: "call_wBKOSbUjPSBA38m8jWknFaOc",
        output: "18°C, sunny",
      },
    ]);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("It’s currently **18°C and sunny** in Lisbon.");
    const finish = finishOf(events);
    expect(finish.reason).toBe("stop");
    expect(finish.message.parts).toEqual([{ type: "text", text }]);
    expect(finish.usage).toEqual([
      { model: "gpt-6.1-sol", inputUncached: 104, cacheRead: 0, cacheWrite: 0, output: 16 },
    ]);
  });
});
