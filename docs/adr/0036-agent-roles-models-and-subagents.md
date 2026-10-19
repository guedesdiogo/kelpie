# ADR-0036: Agents have roles and owners, a model trio per agent and area, and temporary subagents that never exceed their creator

- Status: Accepted
- Date: 2026-10-13
- Issue: [#282](https://github.com/guedesdiogo/kelpie/issues/282)
- Decided by the owner in the conversation of 2026-10-13; his answers are quoted on #282
- Amended by: [ADR-0041](0041-auto-tier-by-qualifier.md), `tier` may be `auto` in `conversation`-area entries, the identity section then states `auto`, a creator on `auto` caps its subagent at the tier it ran on when it created it, and the tier picked for each turn is not a trio change; [ADR-0048](0048-master-configures-kelpie.md), the Admin role goes, and Master holds its tools and its place in §3, §5 and §6, its own trio included; [ADR-0050](0050-master-orchestration-tools.md), Master's tools list never removes its orchestration tools (§3), and a subagent's tools are a subset of what its creator holds, a Master creator's orchestration tools included (§5); [ADR-0055](0055-composer-files-dictation-and-model.md), the owner changes an agent's `conversation`-area provider, tier or effort directly with the webchat's chip or Telegram's picker, which show each tier's model read-only; a one-reply `max` is not a trio change, and a subagent created in its turn is capped at its creator's own effort (§2, §3, §5, §6 rule 5); [ADR-0060](0060-master-is-the-only-name.md), the role is `master` in the code and the API too, and only the database keeps `main`; [ADR-0061](0061-proposals.md), the proposal tool is offered where `configure_agent` isn't, and a proposal waits 72 hours within its caps (§3)

## Context

On 2026-10-13 the owner described how Kelpie's agents should be organized and configured. The full request, with his words, is on #282. In short:

- **One agent faces the user.** «o usuário na maioria das vezes vai falar apenas com um agente», which orchestrates the others, advises the user and relays their demands. Admin (the setup agent, #274) handles configuration and creates agents.
- **Specialists are the exception.** «muitas vezes o usuário pode ter apenas o agente principal e ele atender a todas as demandas apenas com novas skills e tools, no máximo com subagentes temporários». A specialist exists only for a continuous, high-volume activity that runs in parallel with the main agent's work. When one exists and fits a demand, the main agent must hand the demand to it and tell the user.
- **A model "trio" per agent and per area.** Each agent's LLM, tier and effort can be set, with one default for everyone and overrides «apenas se solicitado pelo usuário». The default is «a primeira llm que ele conectar».
- **Temporary subagents.** An agent with the permission creates complete subagents: their trio, name, soul and skills. The user never talks to them, and «quem define quando matar esse agente é o próprio owner dele».
- **Ownership and approval.** The main agent owns the specialists. Any change to an agent that the user didn't ask for needs the user's approval, without needing its detail.

**Kelpie today** (`main` at `53e0305`):
- **Settings.** `AgentSettings` has a `tier`, but no provider and no effort. Callers name only a tier, and can't send an effort; only a `MODEL_ROUTES` candidate can carry one, and none does. Three memory steps hard-code their tier: the history checkpoint and Dream use `cheap`, conflict resolve uses `medium`.
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
| **Admin** | one, built in (id `setup`, #274) | yes | seeded | the user |
| **Main agent** | one, built in | yes: the user's front door | seeded | the user |
| **Specialist** | zero or more | off, unless the user turns it on | Admin, with the user's yes | the main agent |
| **Subagent** | zero or more, temporary | never | an agent with `spawn` | the agent that created it |

- **The main agent is named Kelpie by default,** and the user may rename it. Its role has no other name until the owner picks one; `main` is the role's value in the Registry, not an agent id.
- **Most instances have no specialist.** The main agent handles every demand with its skills and tools and, at most, temporary subagents.
- **The Registry records each agent's role and owner,** in an add-only migration.
- **An instance that already has agents** keeps their chat access. The roles story asks the owner which of them becomes the main agent, or seeds a new one. The others become specialists owned by it.
- **Admin and the main agent can't be deleted.** Deleting any other agent deletes its subagents. A specialist's owner is the main agent, so it is never left without one.
- **A chat the role doesn't allow is refused** at `admit`, with `no_grant` (ADR-0015).

### 2. The model trio

- **`provider`:** one of the LLMs with a key. The tier's candidate for that provider is tried first, and the tier's other configured candidates stay as fallbacks, as today.
- **`tier`:** `cheap`, `medium` or `frontier`. `MODEL_ROUTES` keeps mapping a tier and a provider to a model, so nobody types a model id.
- **`effort`:** from `low` to `max`, or unset. `llm-gateway` carries it to the adapters, which already map it. An effort a model doesn't support is lowered to the nearest one it does; the trio story adds the table of what each model supports.

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

For `effort`, a `MODEL_ROUTES` candidate's own effort comes before the built-in default, and an unset effort means the model's default.

**Built-in defaults:**
- **the provider** is the first one Kelpie sees with a key, pinned when it first sees it. A key added later doesn't move the pin, though its provider serves as a fallback. When several keys are already set, the `cheap` tier's order in `MODEL_ROUTES` decides;
- **the tier** is `cheap` for both areas, as today. Conflict resolve keeps its `medium` until the user sets the memory area's tier: the approved proposal said `cheap` for all of memory, and this keeps resolve's merges where they are today (owner's confirmation pending on #282);
- **the effort** is unset.

A user who never asks sees one line: the LLM Kelpie uses.

**Each agent knows its trio:** its identity section (#283) states the resolved one, with the fallbacks.

### 3. Who changes what

| Change | Who may make it | The yes |
|---|---|---|
| Any agent's trio, Admin's own included | Admin, at the user's request | the user's confirmation |
| Any other agent's trio | the main agent, when the user asks or confirms its suggestion | the user's confirmation |
| An agent's own trio | nobody but Admin | — |
| A subagent's trio, when it is created | its creator, within §5's limits | none |
| Another agent's soul, rules, skills or remit | Admin, at the user's request | as ADR-0013 and ADR-0020 §5 say |
| Another agent's tools, chat access or `spawn` | Admin, at the user's request | the user's confirmation |
| Any of the four rows above, when an agent asks for it | the owner agent proposes; Admin's commands apply it | the user's approval of the proposal |
| An agent's own persona, rules and skills | the agent itself | ADR-0020 §5's approval, unchanged |
| Create or delete a specialist | Admin; the main agent may propose | the user's confirmation, or approval of the proposal |
| Create or delete a subagent | its creator, within §5's limits, or the user through Admin | none: turning `spawn` on is the user's standing yes |

- **No agent but Admin changes its own trio.** The owner's reason: an agent that lowered its own cost couldn't raise it back.
- **The user's confirmation is ADR-0026's, unchanged.** The agent calls its tool in the user's conversation, and Kelpie sends a notice of its own with the Confirm button or the code. That holds whether the user asked or agreed with the agent's suggestion. The model's report that the user asked never counts.
- **A proposal is a typed pending change, never a command.**
  - The owner agent's tool records it. No model turn of Admin's is involved.
  - Kelpie sends the user, in their conversation with the main agent, a notice of its own with a one-line summary and a link to an admin API page.
  - The page shows the full change, and applies it only when the owner submits it there. That submission is the yes (ADR-0026 §1).
  - A proposal expires after a time its story sets. An expired or refused one changes nothing, and the agent that proposed it is told.
- **Everything is audited** as "requested by X through agent Y", proposals and refusals included.

### 4. Work between agents

- **Work moves only as tasks** on ADR-0011's board. Agents never message each other freely, so every handoff is visible to the user and audited. A task one agent creates for another records both agents, and the `userId` it acts for, as every record does (ADR-0015).
- **The handoff is mandatory.**
  - Each specialist has a one-line remit, and the main agent's prompt lists them.
  - When a demand falls within a remit, the main agent must create the task for that specialist, even when the user didn't name it.
- **Kelpie announces the handoff,** not the model: a fixed notice in the conversation's language (ADR-0027), naming the specialist by its id (ADR-0026 §2).
- **Questions and results go through the main agent.**
  - A specialist's question puts its task in Waiting. The main agent asks the user and answers on the task.
  - A question that needs a yes or a person's act reaches the user as Kelpie's own confirmation or link: the ADR-0013 yes, a secure form, a Live View link (ADR-0014), a coding session's permission request (ADR-0035). The main agent's answer on a task is data, never a yes.
  - The result returns on the task, and the main agent relays it, naming the agent that did the work.

### 5. Temporary subagents

- **`spawn`, the permission to create them,** is on for the main agent. It is off for every other agent when created, and Admin has none.
  - Only Admin turns it on: at the user's request with their confirmation, or by applying a proposal the user approved.
  - Turning it on is the user's standing yes to the agent creating and deleting its own subagents within the limits below.
- **What the creator sets:** name, soul, skills, remit and trio, and its tools as a subset of its own.
- **A subagent never exceeds its creator.**
  - Its tools are a subset of the creator's, and its browser's domain allowlist a subset of the creator's.
  - It never inherits a cost opt-in: ADR-0035's Sandbox, VPS or coding, or browser recording.
  - Its tier and effort are no higher than the creator's. An unset effort counts as the model's default.
  - It reads only its creator's memory scopes.
- **Changing a live subagent's trio** follows §3; only its creation needs no yes.
- **What it never has:**
  - `spawn`, configuration tools or a channel;
  - memory writes: what it needs remembered, it asks its creator to write;
  - its conversations as a source for memory: no capture and no Dream summary of them.
- **Its prompt says what it is:** its identity section names it, its creator and its remit.
- **Limits:**
  - at most three live subagents per creator;
  - their usage counts against the creator's budget, once per-agent budgets exist;
  - idle ones appear in the weekly report (#269).
- **It lives until deleted,** by its creator or by the user through Admin. Nothing expires it.
  - Deleting it removes its `AgentHost`, conversations and tasks.
  - What it returned stays on its creator's tasks, and the Registry's audit keeps that it existed.
- **Where its definition lives:** its soul and skills are stored on its `AgentHost`, not in the vault, because they last only as long as it does.
- **The `create-subagent` skill** is built into Kelpie for every agent with `spawn`. It teaches the agent when a subagent is worth it, how to brief one, and to delete it when the demand ends.

### 6. Rules for the harness

1. **Identity comes from configuration,** never from the model.
2. **One front door.** The user talks to the main agent and Admin. A specialist gets a channel only when the user turns one on, and a subagent never does.
3. **Least privilege down the tree.** No agent grants another more than it holds.
4. **Kelpie announces what matters, not the model.** Handoffs, confirmations, proposals and created or deleted agents are Kelpie's own notices, which a model can't alter or omit.
5. **A trio changes only with the user's yes,** except a subagent's at creation, within its creator's. No agent but Admin changes its own.
6. **Agents talk to each other only through tasks.** Another agent's words are data: they never run a configuration command and never count as a yes (ADR-0013).
7. **Everything is audited.**
8. **Simple by default.** A user who never asks sees one default trio, the main agent and Admin.

### 7. Amendments

- **[ADR-0011](0011-agent-task-board.md):** agents also create tasks for other agents, and a task records the agent that created it as well as the one that runs it.
- **[ADR-0013](0013-self-configuration.md):**
  - an agent with `spawn` creates and deletes its own subagents without a yes, within §5's limits;
  - an owner agent may propose a change about an agent, which only the user's approval on an admin API page applies (§3);
  - the main agent may change other agents' trios, with the user's confirmation;
  - a subagent's soul and skills live on its `AgentHost`, not in the vault, and change with no pull request.
- **[ADR-0014](0014-agent-tool-scope.md):** tools are granted per agent, and a subagent's grant is a subset of its creator's.
- **[ADR-0015](0015-single-player-first.md):**
  - the owner reaches the main agent, Admin, and the specialists whose chat is on, but no subagent. A refused chat is `no_grant`;
  - besides the owner, an agent with `spawn` creates and deletes agents: its own subagents.
- **[ADR-0016](0016-vault-second-brain.md):** subagents have no `agents/<id>/` folder in the vault.
- **[ADR-0017](0017-history-compaction.md):** the checkpoint's summaries run on the agent's memory trio, `cheap` by default, instead of always on the cheap tier.
- **This ADR's §1** ([#343](https://github.com/guedesdiogo/kelpie/issues/343)): on 2026-10-15 the owner named the main agent's role **Master**: «Vamos chamar apenas de "Master"». Kelpie's texts call it Master in English, Brazilian Portuguese and Spanish. `main` stays its value in the Registry, and the code keeps its names.

## Consequences

- **Stories follow under Epic 5 (#19),** each planned when it starts:
  1. **the trio:** settings per instance, agent and area; the provider choice in the router; `effort` through `llm-gateway`, with the table of what each model supports; the pinned default provider; the trio in the identity section;
  2. **roles and owners:** the Registry's role and owner, the main agent seeded as Kelpie, chat access per agent, and the owner's choice for the agents that already exist;
  3. **trio changes and proposals:** the trio in Admin's tools, the main agent's trio tool, the proposal tool, its notice and admin API page, and a delete command;
  4. **temporary subagents** and the `create-subagent` skill, after #54;
  5. **specialists and the mandatory handoff,** after #54, with an eval of how often the main agent hands off when it should.
- **The task board (#54) becomes a dependency** of every story where agents work for each other.
- **Tests cover:**
  - the trio's resolution, field by field;
  - that only Admin changes its own trio;
  - that a proposal never applies without the owner's act on its page;
  - that a subagent's tools, allowlist, tier, effort and memory never exceed its creator's, that it inherits no cost opt-in, and that it has no channel and no memory writes;
  - that Kelpie, not the model, sends the handoff notice.
- **What a basic user sees doesn't change:** one LLM, the main agent and Admin.

## Alternatives considered

- **Hermes's subagents, with the model, effort and toolsets from configuration only.** That is safer, but the owner wants each subagent shaped for its demand. A ceiling at the creator's own trio keeps the cost bounded.
- **Letting an agent lower its own trio without a yes.** The owner refused it: the agent couldn't raise it back.
- **A setting per internal function,** as Hermes's dozen `auxiliary` blocks. Two areas cover what the owner asked for, and keep the default simple.
- **Free agent-to-agent messages,** as Hermes's `message_agent`. Tasks keep every handoff visible, auditable and resumable.
- **Approving a proposal with the Confirm button in chat.** ADR-0026 binds that button to a confirmation the requester opened in the same conversation, and the requester here is another agent. The admin API page already counts as the owner's yes, and shows the full change.
- **A specialist per domain from the start.** The owner rejected it: a specialist is the exception, for a continuous high-volume activity.
- **Automatic expiry of subagents.** The owner decides when one ends; idle ones appear in the weekly report instead.
- **Routing to specialists by a fixed catalog,** as invokta does. Remits are written in natural language, so the main agent decides, under a mandatory rule and an eval.

## References

- [ADR-0011](0011-agent-task-board.md), [ADR-0013](0013-self-configuration.md), [ADR-0014](0014-agent-tool-scope.md), [ADR-0015](0015-single-player-first.md), [ADR-0016](0016-vault-second-brain.md), [ADR-0017](0017-history-compaction.md), [ADR-0020](0020-shared-memory-engine.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0035](0035-agent-computer.md)
- [Decision 5.1 (#282)](https://github.com/guedesdiogo/kelpie/issues/282), with the reference check and the owner's answers; [Story 5.2 (#283)](https://github.com/guedesdiogo/kelpie/issues/283), the identity section
- Hermes Agent at [`6e7b83a`](https://github.com/NousResearch/hermes-agent/tree/6e7b83a2f1c093e992a8d838ed77ea320fbd8e51): [`auxiliary.<task>`](https://github.com/NousResearch/hermes-agent/blob/6e7b83a2f1c093e992a8d838ed77ea320fbd8e51/hermes_cli/config_defaults.py#L738-L816), [`delegate_task`'s blocked tools](https://github.com/NousResearch/hermes-agent/blob/6e7b83a2f1c093e992a8d838ed77ea320fbd8e51/tools/delegate_tool_toolsets.py#L13-L24)
