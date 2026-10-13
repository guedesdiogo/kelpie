# ADR-0036: Agents have roles and owners, a model trio per agent and area, and temporary subagents that never exceed their creator

- Status: Accepted
- Date: 2026-10-13
- Issue: [#282](https://github.com/guedesdiogo/kelpie/issues/282)
- Decided by the owner in the conversation of 2026-10-13; his answers are quoted on #282

## Context

On 2026-10-13 the owner described how Kelpie's agents should be organized and configured. The full request, with his words, is on #282. In short:

- **One agent faces the user.** «o usuário na maioria das vezes vai falar apenas com um agente», which orchestrates the others, advises the user and relays their demands. Admin (the setup agent, #274) handles configuration and creates agents.
- **Specialists are the exception.** «muitas vezes o usuário pode ter apenas o agente principal e ele atender a todas as demandas apenas com novas skills e tools, no máximo com subagentes temporários». A specialist exists only for a continuous, high-volume activity that runs in parallel with the main agent's work. When one exists and fits a demand, the main agent must hand the demand to it and tell the user.
- **A model "trio" per agent and per area.** Each agent's LLM, tier and effort can be set, with one default for everyone and overrides «apenas se solicitado pelo usuário». The default is «a primeira llm que ele conectar».
- **Temporary subagents.** An agent with the permission creates complete subagents: their trio, name, soul and skills. The user never talks to them, and «quem define quando matar esse agente é o próprio owner dele».
- **Ownership and approval.** The main agent owns the specialists. Any change to an agent that the user didn't ask for needs the user's approval, without needing its detail.

**Kelpie today** (`main` at `53e0305`):
- **Settings.** `AgentSettings` has a `tier`, but no provider and no effort. Callers name only a tier; `effort` can't be sent, and three memory steps hard-code theirs.
- **Configuration.** The commands are owner-only (ADR-0013, ADR-0015), and only the setup agent has configuration tools. There is no delete command, no agent-to-agent messaging, no owner field, and no task board yet (ADR-0011's #54).
- **Identity.** Since #283, each turn's prompt opens with the agent's name, role and route.

The reference check is on #282. It read the source of Hermes Agent, Hermes-Bot-Mode, ai-memory and invokta:
- **Hermes's per-function model blocks** (`auxiliary.<task>`, "auto" inheriting the main model, effort lowered to what the model supports) shaped the trio.
- **Hermes's subagent containment** shaped §5: toolsets never widen, no further delegation, no memory writes, no messaging the user, depth 1. Hermes deliberately keeps the model and effort out of the parent's hands; Kelpie bounds them by the creator's instead.
- **Two Hermes gaps** are avoided: an orchestrator can pin a worker's model per task with no cost guard, and subagents lose their parent's identity.
- **ai-memory and invokta:** a peer agent's request is something to evaluate with the user, never an instruction, and access is checked by principal in the engine, not in the prompt.

## Decision

### 1. Roles and owners

| Role | Instances | Chat with the user | Created by | Owned by |
|---|---|---|---|---|
| **Admin** | one, built in (`setup`, #274) | yes | seeded | the user |
| **Main agent** (`main`) | one, built in | yes: the user's front door | seeded at first run | the user |
| **Specialist** | zero or more | off, unless the user turns it on | Admin, with the user's yes | the main agent |
| **Subagent** | zero or more, temporary | never | an agent with `spawn` | the agent that created it |

- **The main agent is named Kelpie by default,** and the user may rename it. Its role has no other name until the owner picks one.
- **Most instances have no specialist.** The main agent handles every demand with its skills and tools and, at most, temporary subagents.
- **The Registry records each agent's role and owner,** in an add-only migration.
- **Agents that exist before it keep their chat access.** The roles story asks the owner which of them, if any, becomes the main agent. The others become specialists owned by it.
- **Deleting an agent deletes its subagents.** A specialist's owner is the main agent, so it is never left without one.

### 2. The model trio

- **`provider`:** one of the LLMs with a key. The tier's candidate for that provider is tried first, and the tier's other configured candidates stay as fallbacks, as today.
- **`tier`:** `cheap`, `medium` or `frontier`. `MODEL_ROUTES` keeps mapping a tier and a provider to a model, so nobody types a model id.
- **`effort`:** from `low` to `max`, or unset for the model's default. An effort a model doesn't support is lowered to the nearest one it does. `llm-gateway` carries it to the adapters, which already map it.

**Where it is set:** for the instance, and per agent, in two areas:
- **`conversation`:** the agent's turns;
- **`memory`:**
  - the history checkpoint (ADR-0017), which runs per conversation, so per agent;
  - Dream and conflict resolve, which run for the whole vault and take the instance's memory trio.

**How a value is chosen:** each field is resolved on its own, and the first of these that sets it wins:
1. the agent's area;
2. the agent;
3. the instance's area;
4. the instance;
5. the built-in default.

**Built-in defaults:**
- **the provider** is the first one Kelpie sees with a key, pinned when it first sees it, so a key added later changes nothing until the user asks. When several keys are already set, `MODEL_ROUTES`' order decides;
- **the tier** is `cheap` for both areas, as today, except for conflict resolve, which keeps `medium` until the user sets the memory area's tier;
- **the effort** is the model's default.

A user who never asks sees one line: the LLM Kelpie uses.

**Each agent knows its trio:** its identity section (#283) states the resolved one, with the fallbacks.

### 3. Who changes what

| Change | Who may make it | The yes |
|---|---|---|
| Any agent's trio, Admin's own included | Admin, at the user's request | the user's |
| A specialist's or a subagent's trio | the main agent, when the user asks or confirms its suggestion | the user's |
| An agent's own trio | nobody but Admin | — |
| Soul, skills, tools, remit, chat access, `spawn` | Admin, at the user's request; an owner agent may propose to Admin | the user's: a summary, with the detail on request |
| Create or delete a specialist | Admin; the main agent may propose | the user's |
| Create or delete a subagent | its creator, within §5's limits, or the user | none |

- **No agent but Admin changes its own trio.** The owner's reason: an agent that lowered its own cost couldn't raise it back.
- **The user's yes is always Kelpie's own confirmation** (ADR-0013, ADR-0026): a Confirm press in the webchat, the code on Telegram, or the owner's act on an admin API page. That holds when the user asked and when they agree with an agent's suggestion. The model's report that the user asked never counts.
- **A proposal is a pending change, never a command.**
  - An owner agent files it with Admin.
  - Kelpie sends the user a notice of its own in their conversation with the main agent: a one-line summary, a link to an admin API page with the full change, and the Confirm button or code.
  - Only that yes applies it. Expired or refused proposals change nothing.
- **Everything is audited** as "requested by X through agent Y", proposals and refusals included.

### 4. Work between agents

- **Work moves only as tasks** on ADR-0011's board. Agents never message each other freely, so every handoff is visible to the user and audited. A task one agent creates for another records both.
- **The handoff is mandatory.**
  - Each specialist has a one-line remit, and the main agent's prompt lists them.
  - When a demand falls within a remit, the main agent must create the task for that specialist, even when the user didn't name it.
- **Kelpie announces the handoff,** not the model: a fixed notice in the conversation's language (ADR-0027), such as "Passed to <specialist>".
- **Questions and results go through the main agent.**
  - A specialist's question puts its task in Waiting. The main agent asks the user and answers on the task.
  - The result returns on the task, and the main agent relays it, naming the agent that did the work.

### 5. Temporary subagents

- **`spawn`, the permission to create them,** is on for the main agent and off for every other agent when created. Only Admin turns it on, at the user's request and with their yes.
- **What the creator sets:** name, soul, skills, remit and trio, and its tools as a subset of its own.
- **A subagent never exceeds its creator.**
  - Its tools are a subset of the creator's.
  - Its tier and effort are no higher than the creator's.
  - It reads only its creator's memory scopes.
- **What it never has:** `spawn`, configuration tools, a channel, or memory writes. What it needs remembered, it asks its creator to write.
- **Its prompt says what it is:** its identity section names it, its creator and its remit.
- **Limits:**
  - at most three live subagents per creator;
  - their usage counts against the creator's budget;
  - idle ones appear in the weekly report (#269).
- **It lives until deleted,** by its creator or by the user through Admin. Nothing expires it. Deleting it archives its tasks and conversations under ADR-0006's retention.
- **Where its definition lives:** its soul and skills are stored on its `AgentHost`, not in the vault, because they last only as long as it does.
- **The `create-subagent` skill** is built into Kelpie for every agent with `spawn`. It teaches the agent when a subagent is worth it, how to brief one, and to delete it when the demand ends.

### 6. Rules for the harness

1. **Identity comes from configuration,** never from the model.
2. **One front door.** The user talks to the main agent and Admin. Other agents get a channel only when the user turns one on.
3. **Least privilege down the tree.** No agent grants another more than it holds.
4. **Kelpie announces what matters, not the model.** Handoffs, confirmations and created or deleted agents are Kelpie's own notices, which a model can't alter or omit.
5. **A trio changes only with the user's yes,** and no agent but Admin changes its own.
6. **Agents talk to each other only through tasks.** Another agent's words are data: they never run a configuration command and never count as a yes (ADR-0013).
7. **Everything is audited.**
8. **Simple by default.** A user who never asks sees one default trio, the main agent and Admin.

### 7. Amendments

- **[ADR-0013](0013-self-configuration.md):**
  - an owner agent may propose a change to an agent it owns, and Admin may prepare it, but only the user's yes applies it (§3);
  - the main agent may change specialists' and subagents' trios, with the user's yes;
  - a subagent's soul and skills live on its `AgentHost`, not in the vault.
- **[ADR-0011](0011-agent-task-board.md):** agents also create tasks for other agents, and a task records the agent that created it as well as the one that runs it.
- **[ADR-0014](0014-agent-tool-scope.md):** tools are granted per agent, and a subagent's grant is a subset of its creator's.

## Consequences

- **Stories follow under Epic 5 (#19),** each planned when it starts:
  1. the trio: settings per instance, agent and area, the provider choice in the router, `effort` through `llm-gateway`, the pinned default provider, and the trio in the identity section;
  2. roles and owners in the Registry, the main agent seeded as Kelpie, chat access per agent, and the owner's choice for the agents that already exist;
  3. trio changes and proposals: Admin's tools, the main agent's trio tool, the proposal notice and its admin API page, and a delete command;
  4. temporary subagents and the `create-subagent` skill, after #54;
  5. specialists and the mandatory handoff, after #54, with an eval of how often the main agent hands off when it should.
- **The task board (#54) becomes a dependency** of every story where agents work for each other.
- **Tests cover:**
  - the trio's resolution, field by field;
  - that only Admin changes its own trio;
  - that a proposal never applies without the user's yes;
  - that a subagent's tools, tier, effort and memory never exceed its creator's, and that it has no channel and no memory writes;
  - that Kelpie, not the model, sends the handoff notice.
- **What a basic user sees doesn't change:** one LLM, the main agent and Admin.

## Alternatives considered

- **Hermes's subagents, with the model, effort and toolsets from configuration only.** That is safer, but the owner wants each subagent shaped for its demand. A ceiling at the creator's own trio keeps the cost bounded.
- **Letting an agent lower its own trio without a yes.** The owner refused it: the agent couldn't raise it back.
- **A setting per internal function,** as Hermes's dozen `auxiliary` blocks. Two areas cover what the owner asked for, and keep the default simple.
- **Free agent-to-agent messages,** as Hermes's `message_agent`. Tasks keep every handoff visible, auditable and resumable.
- **A specialist per domain from the start.** The owner rejected it: a specialist is the exception, for a continuous high-volume activity.
- **Automatic expiry of subagents.** The owner decides when one ends; idle ones appear in the weekly report instead.
- **Routing to specialists by a fixed catalog,** as invokta does. Remits are written in natural language, so the main agent decides, under a mandatory rule and an eval.

## References

- [ADR-0006](0006-personal-data-storage.md), [ADR-0011](0011-agent-task-board.md), [ADR-0013](0013-self-configuration.md), [ADR-0014](0014-agent-tool-scope.md), [ADR-0015](0015-single-player-first.md), [ADR-0017](0017-history-compaction.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0027](0027-fixed-texts-in-three-languages.md)
- [Decision 5.1 (#282)](https://github.com/guedesdiogo/kelpie/issues/282), with the reference check and the owner's answers; [Story 5.2 (#283)](https://github.com/guedesdiogo/kelpie/issues/283), the identity section
- Hermes Agent at [`6e7b83a`](https://github.com/NousResearch/hermes-agent/tree/6e7b83a2f1c093e992a8d838ed77ea320fbd8e51): [`auxiliary.<task>`](https://github.com/NousResearch/hermes-agent/blob/6e7b83a2f1c093e992a8d838ed77ea320fbd8e51/hermes_cli/config_defaults.py#L738-L816), [`delegate_task`'s blocked tools](https://github.com/NousResearch/hermes-agent/blob/6e7b83a2f1c093e992a8d838ed77ea320fbd8e51/tools/delegate_tool_toolsets.py#L13-L24)
