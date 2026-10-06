# Spike: OpenAI Responses streaming through AI Gateway passthrough

- **Date:** 2026-10-06, from runs on 2026-10-05
- **Issue:** [#29](https://github.com/guedesdiogo/kelpie/issues/29)
- **Status:** confirmed in two halves; no single call yet combines a tool definition with the Workers runtime

## Question

The OpenAI adapter ([ADR-0008](../adr/0008-llm-authentication.md)) calls the Responses API through AI Gateway's provider passthrough. [Research note 00 §2B, item 8](../research/00-cross-check.md) left streaming over that path partly verified. The question was whether a streamed Responses call with a tool definition works through the passthrough from a Worker. If it didn't, the adapter design would change.

No throwaway Worker was needed. The runs below came out of the gateway rollout in [#57](https://github.com/guedesdiogo/kelpie/issues/57), and both used the production adapter, `OpenAIResponsesProvider` in `packages/llm/src/openai.ts`. That adapter streams every request (`responses.create` with `stream: true`, `store: false`). It adds the `tools` field only when the request carries tools.

The gateway is `kelpie` on the instance's account. It runs with "Require provider credentials" (`byok_only`) and authentication on, with logs kept and no cache, rate limit or retries.

## Result

| Run | Runtime | Tool | Through the gateway | Outcome |
|---|---|---|---|---|
| [Smoke test](https://github.com/guedesdiogo/kelpie/issues/57#issuecomment-5999405914), `packages/llm/scripts/smoke.ts openai` with `AI_GATEWAY_URL` and `AI_GATEWAY_TOKEN` | Bun, on the owner's machine | yes, `get_weather` | yes | Turn 1 streamed a `function_call` and finished `tool_calls` (70 in / 19 out). Turn 2 replayed it, under `store: false`, with the tool result, and streamed 12 text deltas to `stop` (104 in / 16 out). |
| [Live traffic](https://github.com/guedesdiogo/kelpie/issues/57#issuecomment-6000361007), two Telegram turns | `llm-gateway` Worker, version `ec59294c`, deployed with `OPENAI_BASE_URL` at the gateway | no: conversation turns carry no tools yet | yes | Both turns streamed to a reply (103 / 31 and 163 / 78). |

The gateway's logs show each of these requests with status 200. Each log's token counts equal the usage the adapter read from the stream.

**The adapter design stands.** The SDK's SSE stream passes through the gateway unchanged:
- a streamed tool call and its replay work;
- `cf-aig-authorization` from `AI_GATEWAY_TOKEN` authenticates the call;
- a Worker reads the stream to the end.

## What is not proven

No single call has combined a tool definition with the Workers runtime. Each half ran separately, and both used the same adapter code.
- The tool changes only the JSON body.
- The runtime changes only the `fetch` implementation that reads the stream.

A failure from combining them is therefore unlikely, but not measured.

That will be measured by the first production turn that carries agent tools, through the `conversation: turn usage` log and the gateway log. A tool call that fails there would show as a provider error in `llm-gateway`'s logs. The router would then fall back to another candidate.

## Not covered here

- **Anthropic through the gateway.** It waits for an Anthropic key, by the owner's decision of 2026-10-05; it is tracked on #57.
- **Usage against the OpenAI dashboard.** This is the owner's step, also on #57.
