> Research note written on 2026-10-13 for [#300](https://github.com/guedesdiogo/kelpie/issues/300). It compares Vercel's eve with Kelpie at [`1b1d945`](https://github.com/guedesdiogo/kelpie/tree/1b1d945).

# 10 — eve: what an agent-as-a-directory framework teaches Kelpie

> **Read-only research, done on 2026-10-13.** Nothing was installed or run. eve's source was read at commit [`624be47`](https://github.com/vercel/eve/tree/624be476e38cb40a4a21ec1ff7ed397cb389c047) (npm `eve` 0.79.0, Apache-2.0, public beta since 2026-06-17).
> **Conventions.**
> - `[code]`: read in the implementation. `[doc]`: only eve's docs, README or `research/` notes say it. Many of eve's `research/` notes carry a stale `status:`; where it matters, the note below says what the code does.
> - Links to eve are pinned to the commit above, and links to Kelpie to `1b1d945`.
> - eve is in beta and releases several times a week. Re-check a claim against the current source before building on it.

## TL;DR

1. **Why eve's layout feels simple:**
   - one folder per capability;
   - the path is the name;
   - prose in Markdown and behaviour in TypeScript.
2. **What that simplicity costs:** a build step.
   - Nothing about an agent changes in production without a rebuild.
   - eve has no public way to define an agent from data.
   - Kelpie's agents are created in chat (ADR-0013), so the build-time model doesn't fit.
3. **Kelpie already has the prose half of eve's layout,** in the vault: `agents/<id>/SOUL.md`, `AGENTS.md`, `skills/` and `memory/`.
   - The other half is configuration, code or secrets: model, tools, channels, connections, subagents and computer.
   - It rightly stays behind configuration commands. That is eve's own split, mapped onto vault and commands (§4).
4. **Adopt:**
   - a tool that loads a skill's body when it is needed. Kelpie lists skills, but the model can't read one;
   - broken skills reported, not guessed around;
   - deferred tools when MCP arrives;
   - for [#290](https://github.com/guedesdiogo/kelpie/issues/290): eve's budget split among subagents, and the vault folder's shape for a subagent's definition.
5. **Adapt, with the owner's decision:**
   - routines as `agents/<id>/schedules/*.md` files (Q1);
   - a Continue button at the tool bound instead of a dead end (Q2);
   - model routing per turn with Jev, not now (Q3).
6. **Avoid:**
   - code or a build step in the agent folder;
   - workflow replay as the turn's substrate;
   - a model approving what ADR-0013 reserves for a person;
   - eve's permissive tool defaults.
7. **Where Kelpie is already ahead:** least privilege for subagents, shared skills, memory, and confirmations bound to the exact input.
8. **eve runs on Jev too.** It is eve's default decision model for approvals, model routing and eval judges: the same TypeSafe model as ADR-0009 and ADR-0018.

## 1. What eve is

eve is "a filesystem-first framework for durable AI agents" ([README](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/README.md)). An agent is a directory. eve compiles it at build time and runs it on Vercel's services: AI Gateway, Workflows, Sandbox, Connect and Cron.

```text
agent/
├── instructions.md     # required: the always-on system prompt
├── agent.ts            # optional: model and runtime
├── tools/              # TypeScript; the path is the tool's name
├── skills/             # Markdown playbooks, loaded on demand
├── schedules/          # cron, as Markdown or TypeScript
├── channels/           # HTTP, Slack, Discord, Web Chat…
├── connections/        # MCP and OpenAPI clients
├── subagents/<id>/     # the same layout, one level down
├── hooks/  memory.ts  sandbox/  extensions/  lib/
```

Kelpie is not a framework but an instance. Agents are created at runtime through chat (ADR-0013), and the owner's vault is plain Markdown that works without Kelpie (ADR-0016). The comparison below keeps that difference in view.

## 2. The authoring surface

### 2.1 The slots

The root directory is classified by name, and nothing else counts [code] ([`discover/filesystem.ts#L145-L231`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/discover/filesystem.ts#L145-L231)).

| Slot | Required | Forms | Identity | Helper |
|---|---|---|---|---|
| `instructions.md` (or `.ts`, or `instructions/`) | yes at the root; an error otherwise | Markdown used verbatim, with no frontmatter [code] ([`markdown.ts#L64-L69`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/internal/helpers/markdown.ts#L64-L69)) | — | `defineInstructions` |
| `agent.ts` | no at the root; yes in a subagent, with a `description` | module | the package name, or the folder | `defineAgent` |
| `tools/**` | no | modules, walked recursively | the path, `/` turned to `-`: `tools/billing/refund.ts` is `billing-refund` [code] ([`normalize-tool.ts#L27-L56`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/compiler/normalize-tool.ts#L27-L56)) | `defineTool`, `disableTool` |
| `skills/` | no | `<n>.md`, `<n>.ts` or `<n>/SKILL.md` with `references/`, `assets/`, `scripts/` [code] ([`discover/skills.ts#L58-L63`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/discover/skills.ts#L58-L63)) | the file or folder name | `defineSkill` |
| `schedules/**` | root only; an error in a subagent [code] ([`discover-subagent.ts#L345-L365`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/discover/discover-subagent.ts#L345-L365)) | `<n>.md` with `cron` frontmatter, or `<n>.ts` | the path, slashes kept | `defineSchedule` |
| `channels/**` | root only | modules; path segments are URL segments | the path | `defineChannel` |
| `connections/` | no | `<n>.ts` or `<n>/connection.ts` | the name | `defineMcpClientConnection`, `defineOpenAPIConnection` |
| `subagents/` | no | `<id>/`, the full layout again, or `<id>.ts` for a remote or dynamic one | the folder | `defineAgent`, `defineRemoteAgent` |
| `hooks/**`, `memory.ts`, `sandbox/`, `extensions/`, `lib/`, `instrumentation/` | no | modules | — | `defineHook`, `defineMemory`, `defineSandbox`, `defineExtension` |

Three rules make the layout feel simple:
- **The path is the identity.** The tool, skill and schedule normalizers reject an authored `name` [code] ([`authored-definition/core.ts#L456`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/internal/authored-definition/core.ts#L456), [`#L514`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/internal/authored-definition/core.ts#L514)). A skill's frontmatter `name` is ignored silently; eve reads only `description`, `license`, `metadata` and `deferred` [code] ([`markdown.ts#L128-L189`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/internal/helpers/markdown.ts#L128-L189)).
- **Prose is Markdown, behaviour is TypeScript.** Markdown stays thin on purpose. Instructions take no frontmatter, a schedule's frontmatter takes only `cron`, and a `run` key there gets an error that points to the TypeScript form [code] ([`markdown.ts#L94-L118`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/internal/helpers/markdown.ts#L94-L118)).
- **Framework defaults are files too.** The built-in `bash`, `read_file`, `write_file`, `web_fetch` and `web_search` tools sit at virtual paths such as `tools/bash.ts` [code] ([`framework/sources/registry.ts#L14-L64`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/framework/sources/registry.ts#L14-L64)). A file at the same path replaces the default, and `export default disableTool()` removes it.

The smallest agent is one file [doc]. The weather fixture has four: `agent.ts`, a one-line `instructions.md`, `skills/get-weather.md` and `tools/get_weather.ts` [code] ([`apps/fixtures/weather-agent/agent/`](https://github.com/vercel/eve/tree/624be476e38cb40a4a21ec1ff7ed397cb389c047/apps/fixtures/weather-agent/agent)).

### 2.2 Discovery and compilation

Three stages, all at build time or in `eve dev` [code]:
1. **Discover** reads the tree without importing any module ([`discover-agent.ts#L84-L332`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/discover/discover-agent.ts#L84-L332)). Markdown is parsed here.
2. **Compose and normalize** merges framework defaults, extensions and the app's files into one graph, and imports each module once to check its shape ([`normalize-helpers.ts#L61-L98`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/compiler/normalize-helpers.ts#L61-L98)).
3. **Emit** writes `.eve/`: a JSON manifest, `diagnostics.json`, and a generated `module-map.mjs` of static imports ([`artifacts.ts#L135-L150`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/compiler/artifacts.ts#L135-L150)). The runtime never walks the folder.

Problems are collected, not thrown one at a time. Each is `{code, severity, message, sourcePath}`, such as `discover/slot-collision` when `foo.md` and `foo.ts` both exist, or `discover/skill-frontmatter-invalid`. The build fails once, listing them all [code] ([`compile-agent.ts#L75-L88`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/compiler/compile-agent.ts#L75-L88), [`#L152-L177`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/compiler/compile-agent.ts#L152-L177)). Feedback is weaker at the edges: an unknown root file is ignored without a word, and an unknown folder only warns [code] ([`grammar.ts#L567-L590`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/discover/grammar.ts#L567-L590)).

### 2.3 Skills: an index, then a loader tool

eve adds an "Available skills" block to the instructions, one line per skill with its description and path, and tells the model: "If the user names a skill or the request clearly matches one of the descriptions below, load it with `eve__skill({ name })` before proceeding" [code] ([`execution/skills/instructions.ts#L29-L49`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/skills/instructions.ts#L29-L49)). The loader returns the skill's Markdown as the tool result; the body never enters the system prompt [code] ([`execution/catalog/skills.ts#L65-L82`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/catalog/skills.ts#L65-L82)):

```ts
execute: (input: { readonly name: string }) => {
  const skill = skills.get(input.name);
  if (skill === undefined) throw new Error(`No skill named "${input.name}".`);
  return skill.markdown;
},
```

A `deferred: true` skill is left out of the list. The model finds it with `eve__search`, then loads it [code]. A skill's `references/` and `scripts/` are copied into the sandbox at `$HOME/.agents/skills/<name>/`, where the model reads or runs them with `read_file` and `bash` [code] ([`seed-files.ts#L48-L55`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/runtime/workspace/seed-files.ts#L48-L55)).

This is the pattern Hermes uses too ([note 01 §3](01-hermes-agent-and-bot-mode.md)): an index in the prompt and a tool that loads one skill.

### 2.4 Subagents reuse the layout

A subagent folder is discovered by the same code as the root: instructions, `agent.ts`, tools, skills, connections, sandbox, hooks and nested subagents [code] ([`discover-subagent.ts#L184-L343`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/discover/discover-subagent.ts#L184-L343)). It inherits none of the parent's files; the framework defaults are applied to it again. It reaches the parent's model as a tool taking `{message, taskId?}`, unless its `tool` is `false` or `"deferred"` [code] ([`runtime/subagents/registry.ts#L92-L174`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/runtime/subagents/registry.ts#L92-L174)). Tools marked root-only, including the built-in `agent`, are filtered out of a subagent's session [code] ([`step-catalog.ts#L282-L291`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/catalog/step-catalog.ts#L282-L291)).

### 2.5 What the folder model costs

- **Nothing changes in production without a build.** The set of subagents, channels, schedules and mounts is fixed per build.
- **Agents can't be defined from data.** To vary a slot per caller, eve added `defineDynamic` resolvers that run at `session.started`, `turn.started` or `step.started`. The resolver still sits in a file at its slot, and a dynamic subagent still needs its compiled folder [doc]. eve's own defaults use "programmatic sources", whose API "is internal" and "does not … create programmatic subagent nodes, or virtualize markdown and skill asset files" [doc] ([`research/programmatic-agent-sources.md#L37`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/research/programmatic-agent-sources.md#L37), [`#L167-L169`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/research/programmatic-agent-sources.md#L167-L169)).
- **Configuring from chat means editing files.** In `eve dev`, a built-in self-modification subagent gets the app's `agent/` folder mounted read-write at `/source`; the watcher recompiles and the change applies on the next turn [code] ([`self-modification/filesystem.ts#L29-L39`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/self-modification/filesystem.ts#L29-L39)). Its remote variant opens a draft pull request instead [doc]. The one exception stored outside files is the experimental `defineDynamicSchedules`, which gives the model create, update and delete tools for schedules [code] ([`public/schedules/subscription.ts#L292-L360`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/public/schedules/subscription.ts#L292-L360)).
- **Sharing between agents is heavy.** A subagent inherits nothing, so sharing a skill takes an extension package, mounted under a namespace (`ns__`), with override folders and collision rules.
- **Renaming a file renames the capability**, along with eval assertions and extension state keys.
- **Durable replay leaks into authoring.** Dynamic callbacks must close over JSON-serializable values only, and eve rewrites authored modules at build time to make that hold [doc].

Docs and code disagree in small ways: a comment says `tools/` is walked flat while the code recurses ([`named-source-directory.ts#L101`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/discover/named-source-directory.ts#L101) against [`discover-agent.ts#L216-L226`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/discover/discover-agent.ts#L216-L226)), and the subagent-projection note says `in-progress` for code that has shipped.

## 3. The runtime

### 3.1 Sessions on durable workflows

A session is one long-lived run of the Workflow SDK (`@workflow/core`); a turn is a loop of steps, and a step is one model call and the tool calls that follow it [code] ([`execution/session/entry.ts#L58-L68`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/session/entry.ts#L58-L68), [`turn.ts#L167-L258`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/session/turn.ts#L167-L258)).
- **Between messages the run parks** on durable hooks and holds no compute [doc]. One inbox queue is fed by the session's hook and each channel's continuation address; cancel and reset skip the queue and abort the active turn [code] ([`session-inbox/inbox.ts#L83-L140`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/session-inbox/inbox.ts#L83-L140)).
- **eve owns the loop, not the AI SDK.** Each harness step makes one model call with `stopWhen: isStepCount(1)`, so every iteration is a checkpoint [code] ([`harness/model-call/call.ts#L353-L393`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/harness/model-call/call.ts#L353-L393)).
- **There is no per-turn bound on steps.** The bounds are per session: input tokens (40M by default), output tokens and dollar cost, checked before each model call [code] ([`shared/agent-definition.ts#L187-L226`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/shared/agent-definition.ts#L187-L226)). Reaching one doesn't fail the session: the turn holds on a fixed "continue or stop" request [code] ([`harness/hitl/budget-request.ts#L1-L21`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/harness/hitl/budget-request.ts#L1-L21)).
- **Compaction** runs at 90% of the model's window. It first trims old oversized tool results, then summarizes older messages into a checkpoint that a later one replaces, and keeps the recent tail verbatim [code] ([`harness/compaction/engine.ts#L170-L260`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/harness/compaction/engine.ts#L170-L260)).
- **Replay has a price.**
  - A step interrupted mid-way runs again, so side effects must be idempotent or behind an approval [doc] ([`execution-model-and-durability.mdx#L202-L210`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/docs/concepts/execution-model-and-durability.mdx#L202-L210)).
  - Workflow step ids carry eve's version. Off Vercel, every eve upgrade strands every parked session; eve parks them and starts a replacement on the next message [code] ([`stranded-replay-guard.ts#L22-L96`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/session-inbox/stranded-replay-guard.ts#L22-L96)).
  - eve measured about 3.1 s of overhead per sequential turn on Vercel Workflow [doc] ([`research/turn-performance.md#L9-L57`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/research/turn-performance.md#L9-L57)).

### 3.2 Approvals hold the turn

- **A tool declares `approval`.** The policy answers `approved`, `denied`, `user-approval` or `not-applicable`. The helpers are `always()`, `never()` and `once()` per session [code] ([`tools/approval/policies.ts#L96-L131`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/tools/approval/policies.ts#L96-L131)).
- **`auto()` lets a model approve.** It asks a decision model, `typesafe-ai/jev` by default, whether the exact call is `clear` or needs `caution`. On an error or a 30 s timeout it falls back to asking the user [code] ([`policies.ts#L26-L64`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/tools/approval/policies.ts#L26-L64)).
- **The policy runs again just before an approved call executes** [code] ([`harness/tools.ts#L204-L273`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/harness/tools.ts#L204-L273)).
- **While it waits, the turn stays open.** An answer resumes it. A new message from the same person steers the turn and drops the request; anyone else's message queues behind it [code] ([`turn.ts#L351-L380`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/session/turn.ts#L351-L380)).
- **Only the requester may answer,** unless the tool defines a `response` policy [code] ([`harness/hitl/coordinator.ts#L160-L178`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/harness/hitl/coordinator.ts#L160-L178)). On Telegram the request is an inline keyboard [code] ([`telegram/hitl.ts#L72-L87`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/public/channels/telegram/hitl.ts#L72-L87)).
- **The defaults are permissive.** A tool without `approval` runs without asking, and the built-in `bash` and `write_file` declare none [code] ([`tools/provided/bash.ts`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/tools/provided/bash.ts), [`write-file.ts`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/tools/provided/write-file.ts)).

### 3.3 Subagents, tasks and budgets

- **Each subagent call is an async task.** The model gets a receipt, can start several, and waits with `eve__task_wait`. At most 32 tasks work at once ([`tasks/table.ts#L18`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/tasks/table.ts#L18)), and a turn can't end while its tasks are working [code] ([`execution/tasks/tool-entry-point.ts#L5-L21`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/tasks/tool-entry-point.ts#L5-L21), [`turn.ts#L323-L349`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/session/turn.ts#L323-L349)). These tasks live inside a turn. They are not a board like ADR-0011's.
- **A child never outspends its parent.** Children started together split the parent's remaining tokens and dollars evenly, and an authored child limit is cut to that share [code] ([`subagents/token-budget.ts#L5-L40`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/subagents/token-budget.ts#L5-L40)).
- **Spend is bounded, capabilities are not.** A declared subagent's tools are whatever its folder holds [doc] ([`docs/subagents/index.mdx#L190-L207`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/docs/subagents/index.mdx#L190-L207)). The only structural rule is that a child never gets the root's `agent` tool.

### 3.4 Deferred tools

Large catalogs are the stated problem: Playwright's MCP server costs 13.7k tokens for 21 tools [doc] ([`research/deferred-tools.md#L9-L17`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/research/deferred-tools.md#L9-L17)). eve's answer [code]:
- **Three fixed catalog tools,** `eve__search`, `eve__tool({name, input})` and `eve__skill` ([`protocol/catalog-tools.ts#L1-L5`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/protocol/catalog-tools.ts#L1-L5)).
- **A connection's tools are always deferred.** They never enter the `tools` array, so the prompt cache stays stable ([`step-catalog.ts#L150-L156`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/catalog/step-catalog.ts#L150-L156)).
- **The prompt names only kinds and namespaces,** never the deferred entries ([`listing.ts#L26-L58`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/catalog/listing.ts#L26-L58)).
- **Search is lexical and tiered,** with no embeddings ([`rank.ts#L1-L25`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/catalog/rank.ts#L1-L25)).

### 3.5 Memory, connections, evals

- **Memory is a provider contract.** It recalls at `turn.started` and optionally after compaction, captures at `turn.completed` or before compaction, and offers its own tools [code] ([`public/memory/index.ts#L132-L207`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/public/memory/index.ts#L132-L207)).
  - The built-in `fileMemory()` is one Markdown document per scope, capped at 64 KB, with `save_memory` and `remove_memory` tools and no capture [code] ([`memory/file/provider.ts#L16-L23`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/public/memory/file/provider.ts#L16-L23)).
  - Semantic recall comes only from third-party providers [doc]. Its design note still says `proposed` while the core ships.
- **Connections** are MCP or OpenAPI clients whose tools appear as `<conn>__<tool>`.
  - Interactive sign-in holds the turn until the OAuth callback [code] ([`shared/connection-types.ts#L195-L396`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/shared/connection-types.ts#L195-L396)).
  - Tokens are "never serialized into the durable step payload" [code] ([`authorization-tokens.ts#L1-L15`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/runtime/connections/authorization-tokens.ts#L1-L15)).
- **Evals** are files beside the agent: `evals/**/*.eval.ts` with assertions such as `t.calledTool()` and an optional model judge, run locally or against a live deployment with `--url` [code] ([`evals/define-eval.ts#L29-L38`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/evals/define-eval.ts#L29-L38)).
- **Jev is eve's default decision model** in three places: `auto()` approvals, model routing per turn through `auto` from `eve/models`, and eval judges [code] ([`ai/decide.ts#L10-L27`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/ai/decide.ts#L10-L27); [`research/jev-decision-models.md`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/research/jev-decision-models.md)). It is the same TypeSafe model as ADR-0009 and ADR-0018.

### 3.6 How much is Vercel

eve runs off Vercel on Node: Nitro's Node preset, a local or Postgres "world" for workflows, and AI SDK provider objects instead of AI Gateway strings [code] ([`create-application-nitro.ts#L94-L96`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/internal/nitro/host/create-application-nitro.ts#L94-L96)). There is no Workers or Durable Objects target. Off Vercel it loses:
- **upgrade handoffs:** only Vercel's world advertises `deploymentAffinity`, so every eve upgrade strands parked sessions ([`runnable-owner.ts#L17-L33`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/execution/session-inbox/runnable-owner.ts#L17-L33));
- **Drives,** which are Vercel Sandbox mounts;
- **Vercel Connect** and the Agent Runs trace view;
- **schedules,** which become Vercel Cron Jobs, in UTC only [doc].

eve is a reference for Kelpie, never a dependency.

## 4. Kelpie side by side

A Kelpie agent is three records, not a directory:
- a row in the `Registry` with its id and name ([`registry/schema.ts#L5-L19`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/registry/schema.ts#L5-L19));
- its `AgentSettings` on its `AgentHost` ([`packages/config/src/settings.ts#L15-L51`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/packages/config/src/settings.ts#L15-L51));
- an optional folder in the vault, which `compile(agent)` reads for every turn ([`vault.ts#L634-L652`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/context-store/src/vault.ts#L634-L652)).

| eve | Kelpie at `1b1d945` | Status |
|---|---|---|
| `instructions.md` | `agents/<id>/SOUL.md`, or the configured `systemPrompt`; then the shared and the agent's `AGENTS.md`; an identity section first ([`agent-host.ts#L174-L228`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/agent-host/agent-host.ts#L174-L228)) | implemented |
| `agent.ts` | `AgentSettings`: tier, timings, `toolLoopMs`, qualifier, `memoryCore`. The model trio is ADR-0036 | tier implemented; trio decided |
| `skills/` | `skills/**/SKILL.md` and `agents/<id>/skills/**/SKILL.md`, listed by name and description ([`system-prompt.ts#L14-L25`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/agent-host/system-prompt.ts#L14-L25)) | listed; **no way to load one** |
| `tools/` | `ToolProvider`s wired in code: memory tools for every agent, configuration tools for `setup` ([`ports.ts#L172-L207`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/ports.ts#L172-L207)) | implemented; per-agent grants decided (ADR-0036 §7) |
| turn loop | at most 5 rounds within `toolLoopMs`, then a fixed reply ([`tools.ts#L11-L44`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/tools.ts#L11-L44)) | implemented (ADR-0025) |
| approvals | a confirmation code or button, for exactly the validated input, from the user who asked ([`tools.ts#L47-L57`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/tools.ts#L47-L57)) | implemented (ADR-0013, ADR-0026) |
| compaction | summary checkpoints, a later one updating the earlier, recent turns verbatim | implemented (ADR-0017) |
| `channels/` | `ChannelAdapter`; webchat and Telegram, bound by a configuration command | implemented (ADR-0003) |
| `schedules/` | none for users. Internal Durable Object alarms only; routines are an open point of ADR-0011 | absent |
| `connections/` | MCP on `AgentHost`, Composio as an adapter ([note 03](03-tools-composio-mcp-invokta.md)) | decided, not implemented |
| `subagents/` | temporary subagents whose soul and skills live on their `AgentHost`, never above their creator | decided (ADR-0036 §5) |
| `sandbox/` | the `Computer` port: shell by default, Sandbox or VPS on request | decided (ADR-0035) |
| `memory.ts` | the vault's memory engine: recall, core, search, sessions, Dream, lifecycle | implemented (ADR-0020), far beyond `fileMemory` |

The two layouts already meet in the vault. What a person writes as prose is there; what is code, a secret or a grant stays behind configuration commands. That is eve's own split, Markdown for prose and TypeScript for behaviour, mapped onto Kelpie's vault and commands:

```text
agents/<agent-id>/
├── SOUL.md               # eve's instructions.md; named for Hermes (ADR-0016)
├── AGENTS.md             # rules added to the shared ones
├── skills/<name>/SKILL.md
├── memory/
└── schedules/<name>.md   # proposed, question Q1
```

The rest of eve's slots map to records: `agent.ts` to `AgentSettings`, `tools/` and `connections/` to providers and grants, `channels/` to adapters and the secret store, `subagents/` to their own `AgentHost`, `sandbox/` to the `Computer` port.

## 5. Findings

### Adopt

1. **Load a skill when it is needed.** Kelpie lists skills but gives the model no way to read one. `memory_read` resolves only memory notes ([`layout.ts#L93-L117`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/packages/memory/src/layout.ts#L93-L117)), and `ContextStore.read` is exposed to no tool. eve (§2.3) and Hermes ([note 01 §3](01-hermes-agent-and-bot-mode.md)) agree on the fix:
   - a tool that returns one skill's Markdown as its result, plus a `file` argument for the files beside it, as Hermes's `skill_view(name, path)`;
   - eve's wording in the prompt: load a skill when the request clearly matches it, load the fewest that cover the task, and say so when loading fails;
   - a name rule. Kelpie names a skill by its frontmatter `name` or its folder, and lists every match ([`vault.ts#L3265-L3292`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/context-store/src/vault.ts#L3265-L3292)). An agent's own skill should win over a shared one of the same name, as eve's dynamic skills override its static ones.

   This needs no ADR: it is a tool in ADR-0014's layer, run by ADR-0025's loop.
2. **Report broken skills instead of guessing.** eve collects every problem as `{code, severity, message, sourcePath}` and shows them all at once (§2.2). Kelpie handles the same problems silently. A `SKILL.md` with malformed frontmatter falls back to its folder's name and an empty description, and duplicates are all listed. Those cases belong in the lint report the vault already writes.
3. **Defer tools once MCP arrives.** Use eve's rules as the design input for the connections story:
   - a connection's tools stay out of the `tools` array, so the prompt cache holds;
   - the prompt names only the namespaces;
   - lexical search comes first.

   This is the `defer_loading` stage note 03 already recommends.
4. **Split a creator's budget among its subagents** once per-agent budgets exist (ADR-0036 §5). eve's rule is concrete:
   - children started together share the creator's remaining tokens and dollars evenly;
   - a later child sees what is left after the earlier ones spent.

   This is input for [#290](https://github.com/guedesdiogo/kelpie/issues/290) and [#269](https://github.com/guedesdiogo/kelpie/issues/269).
5. **Give a subagent the vault folder's shape.** ADR-0036 keeps a subagent's soul and skills on its `AgentHost`. Stored in the same shape as `CompiledContext`, persona, rules and skills, one compose path and one skill loader serve both vault agents and subagents. eve reuses one discoverer for the root and its subagents for the same reason (§2.4). This is input for [#290](https://github.com/guedesdiogo/kelpie/issues/290).

### Adapt, with the owner's decision

1. **Schedules as files in the agent's folder** (Q1). eve's `schedules/<name>.md` is the most readable routine format we have seen: `cron` in the frontmatter and the body as the prompt. eve schedules only in UTC, and a fire with no channel can't ask for approval. Kelpie would need a `timezone` field, and each fire would create a task on the agent's board (ADR-0011) rather than run a bare turn.
2. **A "Continue" at the tool bound** (Q2). After 5 rounds, Kelpie answers "I couldn't finish this within my limits". eve has no per-turn bound. At its session budget, the turn holds on a fixed continue-or-stop request instead of ending (§3.1).
3. **Model routing per turn with Jev** (Q3). eve's `auto({options})` picks a model per turn from described options and keeps the choice for the rest of the turn (§3.5). In Kelpie, that would be a trio option in ADR-0036 and a cost.

### Avoid

1. **Code or a build step in the agent folder.** Kelpie's agents are created in chat (ADR-0013), and the vault must stay readable without Kelpie (ADR-0016). Running code from it would also bypass ADR-0014's and ADR-0035's limits. eve's own workarounds show what the folder model costs once agents vary at runtime (§2.5): `defineDynamic`, internal programmatic sources, and self-modification by rebuilding.
2. **Workflow replay as the turn's substrate.** A Durable Object per conversation (ADR-0002) avoids three of eve's costs:
   - closures that must be JSON-serializable;
   - sessions stranded by every upgrade off Vercel;
   - the ~3.1 s of overhead per turn eve measured.
3. **A model approving what ADR-0013 reserves for a person.** eve's `auto()` approval is a Jev call (§3.2). In Kelpie "the yes always comes from a person", and that stays.
4. **Permissive defaults.** eve's `bash` and `write_file` run with no approval. ADR-0014 and ADR-0035 keep Kelpie stricter.
5. **Sharing through packages.** eve shares a skill between agents only through a namespaced extension package. Kelpie's shared `skills/` folder already does it with one file.

### Already in Kelpie

- **Confirmations.** A confirmation is for the exact validated input, and only the user who asked can give it. That is eve's default for approvals. The webchat's Confirm button counts only from the requester's socket ([`conversation-agent.ts#L364-L388`](https://github.com/guedesdiogo/kelpie/blob/1b1d945/apps/conversation-runtime/src/conversation-agent.ts#L364-L388)).
- **Compaction.** Summary checkpoints with the recent turns kept verbatim, as eve does (ADR-0017).
- **Secrets.** They never enter a conversation (ADR-0013), as eve's tokens never enter a durable payload.
- **Subagents.** ADR-0036 bounds their tools, tier, effort and memory. eve bounds only their spend.
- **Memory.** The memory engine (ADR-0020) goes well past eve's one-document `fileMemory`.

## 6. Questions for the owner

Each of these would amend an ADR, so none changes the design until the owner answers.

- **Q1. Should a routine be a file?** The question is whether `agents/<id>/schedules/<name>.md`, with `cron` and `timezone` in the frontmatter and the task in the body, can be how an agent's routines are kept. The owner would edit it anywhere, and the agent would write its own directly, like memory.
  - **The alternative:** keep schedules only as a configuration command on `AgentHost`, which ADR-0013 runs directly and audits as a smaller change.
  - **Recommended: the file.**
    - It is the simplicity the owner liked.
    - Git keeps the history.
    - Hermes also keeps an agent's cron in the agent's own directory ([note 01](01-hermes-agent-and-bot-mode.md), TL;DR item 11).
  - **What it would amend:** ADR-0011's open point on routines, ADR-0013's list of commands and ADR-0016's layout.
  - **When it lands:** with [#54](https://github.com/guedesdiogo/kelpie/issues/54).
- **Q2. Continue past the tool bound?** When a turn reaches its 5 rounds, Kelpie could send its own notice with a Continue button. Pressing it would be the owner's act (ADR-0026) and would grant one more bound.
  - **Recommended: yes, at low priority.**
  - **What it would amend:** ADR-0025.
- **Q3. Route models per turn?** This would be a trio option that lets Jev pick among described models each turn.
  - **Recommended: not now.** Revisit once [#286](https://github.com/guedesdiogo/kelpie/issues/286) has shipped the trio and [#269](https://github.com/guedesdiogo/kelpie/issues/269) measures cost. It would ship off, as extra cost.

## 7. Next steps

- **Adopt 1 and 2** become one follow-up of [#300](https://github.com/guedesdiogo/kelpie/issues/300): skills that load on demand, and broken skills reported in the lint report.
- **Adopt 4 and 5** go to [#290](https://github.com/guedesdiogo/kelpie/issues/290) as a comment. **Adapt 1** goes to [#54](https://github.com/guedesdiogo/kelpie/issues/54) as a pointer to Q1.
- **Adopt 3** waits for the connections story. No issue exists for it yet.
