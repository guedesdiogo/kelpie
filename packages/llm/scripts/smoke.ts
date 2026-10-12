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
//
// `--auth subscription` checks instead whether Anthropic accepts a Claude subscription token from
// Kelpie (issue #258). ADR-0008 records that this use conflicts with Anthropic's policy, so only the
// owner runs it, with their own token:
//
//   read -rs ANTHROPIC_OAUTH_TOKEN && export ANTHROPIC_OAUTH_TOKEN   # from `claude setup-token`
//   bun packages/llm/scripts/smoke.ts anthropic --auth subscription [--model <id>]
//
// It sends one short turn to api.anthropic.com, never through AI Gateway or ANTHROPIC_BASE_URL, and
// says it is Kelpie: nothing names Claude Code. It never retries and never falls back, so any
// refusal prints as FAIL with its status, Anthropic's error and the request id. `--base-url <url>`
// only points it at a local fake server, to test the script itself.

import { mkdir, writeFile } from "node:fs/promises";
import { AnthropicMessagesProvider } from "../src/anthropic.ts";
import { LlmError } from "../src/errors.ts";
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
// A mistyped flag (`--auth=subscription`, or `--auth` with no value) fails rather than running the
// API-key test in its place.
const auth = option("--auth") ?? (rest.some((arg) => arg.startsWith("--auth")) ? "" : "key");
if (auth !== "key" && auth !== "subscription") {
  fail(`use --auth key or --auth subscription, not "${auth}"`);
}
const subscription = auth === "subscription";
const subscriptionBaseURL = option("--base-url") ?? "https://api.anthropic.com";
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.1-sol",
};

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

let recorded = 0;
/** The last response's `request-id`, which Anthropic asks for when a call is looked into. */
let requestId: string | null = null;
const recordingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  requestId = response.headers.get("request-id");
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
  if (provider === "anthropic" && subscription) {
    if (gateway) fail("unset AI_GATEWAY_URL: the subscription check goes straight to the API");
    // The SDK adds these to every request: they could carry a key or another client's identity.
    if (process.env.ANTHROPIC_CUSTOM_HEADERS) fail("unset ANTHROPIC_CUSTOM_HEADERS");
    const authToken = process.env.ANTHROPIC_OAUTH_TOKEN || fail("set ANTHROPIC_OAUTH_TOKEN");
    return new AnthropicMessagesProvider({
      authToken,
      // Set here, so the SDK never takes ANTHROPIC_BASE_URL and sends the token elsewhere.
      baseURL: subscriptionBaseURL,
      headers: { "user-agent": "Kelpie smoke test (issue #258)" },
      fetch: recordingFetch,
      maxRetries: 0,
    });
  }
  if (subscription) fail("--auth subscription is for anthropic only");
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

if (subscription) {
  const model = option("--model") ?? "claude-haiku-5-5";
  const host = new URL(subscriptionBaseURL).host;
  console.log(`Subscription check: anthropic ${model} at ${host}, one turn, no retry`);
  try {
    await turn(llm, {
      model,
      system: "You are a test assistant for Kelpie.",
      maxOutputTokens: 64,
      messages: [{ role: "user", parts: [{ type: "text", text: "Answer with one word: ok" }] }],
    });
  } catch (error) {
    const status = error instanceof LlmError ? (error.status ?? "none") : "none";
    const message = error instanceof Error ? error.message : String(error);
    fail(`status ${status}, request-id ${requestId ?? "none"}: ${message}`);
  }
  console.log(
    `PASS: Anthropic accepted the subscription token (request-id ${requestId ?? "none"}).`,
  );
  process.exit(0);
}

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
