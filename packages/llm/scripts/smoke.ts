// Manual smoke test of the provider adapters against the real APIs (issue #57). Run it from your
// own terminal with the keys in environment variables; it never prints them:
//
//   export ANTHROPIC_API_KEY=…   # or OPENAI_API_KEY
//   export AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<account>/<gateway>   # optional
//   export AI_GATEWAY_TOKEN=…    # only for an authenticated gateway
//   bun packages/llm/scripts/smoke.ts anthropic [--model <id>] [--record <dir>]
//
// It runs two turns with a tool: the second replays the first turn's native output, so it checks
// streaming through the gateway and that replayed reasoning is accepted. `--record` saves the raw
// response streams (bodies only, no headers) to replace the hand-built test fixtures.

import { mkdir, writeFile } from "node:fs/promises";
import { AnthropicMessagesProvider } from "../src/anthropic.ts";
import { OpenAIResponsesProvider } from "../src/openai.ts";
import type { ChatMessage, LlmEvent, LlmProvider, LlmRequest } from "../src/types.ts";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

const [provider = "", ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const recordDir = option("--record");
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.1-sol",
};

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

let recorded = 0;
const recordingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!recordDir || !response.body) return response;
  const [forCaller, forFile] = response.body.tee();
  const file = `${recordDir}/${provider}-${++recorded}.sse`;
  void new Response(forFile).text().then(async (text) => {
    await mkdir(recordDir, { recursive: true });
    await writeFile(file, text);
  });
  return new Response(forCaller, response);
};

function adapter(): LlmProvider {
  const gateway = process.env.AI_GATEWAY_URL;
  const token = process.env.AI_GATEWAY_TOKEN;
  const headers = token ? { headers: { "cf-aig-authorization": `Bearer ${token}` } } : {};
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? fail("set ANTHROPIC_API_KEY");
    return new AnthropicMessagesProvider({
      apiKey,
      ...(gateway ? { baseURL: `${gateway}/anthropic` } : {}),
      ...headers,
      fetch: recordingFetch,
    });
  }
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? fail("set OPENAI_API_KEY");
    return new OpenAIResponsesProvider({
      apiKey,
      ...(gateway ? { baseURL: `${gateway}/openai` } : {}),
      ...headers,
      fetch: recordingFetch,
    });
  }
  return fail("usage: bun packages/llm/scripts/smoke.ts <anthropic|openai> [--model <id>]");
}

async function turn(llm: LlmProvider, request: LlmRequest) {
  let deltas = 0;
  let finish: Extract<LlmEvent, { type: "finish" }> | undefined;
  for await (const event of llm.stream(request)) {
    if (event.type === "text") deltas += 1;
    else finish = event;
  }
  if (!finish) fail("the stream ended without a finish event");
  const nativeTypes = (finish.message.native?.content ?? []).map(
    (item) => (item as { type?: string }).type ?? "?",
  );
  console.log(
    JSON.stringify(
      {
        reason: finish.reason,
        textDeltas: deltas,
        parts: finish.message.parts.map((part) => part.type),
        native: nativeTypes,
        usage: finish.usage,
      },
      null,
      2,
    ),
  );
  return finish;
}

const llm = adapter();
const model = option("--model") ?? DEFAULT_MODEL[provider] ?? fail("unknown provider");
const base: Omit<LlmRequest, "messages"> = {
  model,
  system: "You are a test assistant. Always use the get_weather tool for weather questions.",
  maxOutputTokens: 2_048,
  tools: [
    {
      name: "get_weather",
      description: "Current weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
};

console.log(`Turn 1: ${provider} ${model}${process.env.AI_GATEWAY_URL ? " via AI Gateway" : ""}`);
const question: ChatMessage = {
  role: "user",
  parts: [{ type: "text", text: "What's the weather in Lisbon right now?" }],
};
const first = await turn(llm, { ...base, messages: [question] });
const call = first.message.parts.find((part) => part.type === "tool_call");
if (first.reason !== "tool_calls" || !call || call.type !== "tool_call") {
  fail(`expected a tool call, got reason "${first.reason}"`);
}

console.log("Turn 2: replaying turn 1's native output with the tool result");
const second = await turn(llm, {
  ...base,
  messages: [
    question,
    first.message,
    { role: "tool", results: [{ callId: call.id, output: "18°C, sunny" }] },
  ],
});
if (second.reason !== "stop") fail(`expected a final answer, got reason "${second.reason}"`);
console.log(`PASS: ${provider} streamed, called the tool and accepted the replayed turn.`);
if (recordDir) console.log(`Recorded ${recorded} response streams in ${recordDir}.`);
