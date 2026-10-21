# ADR-0063: A turn that read outside content asks the owner before it changes anything

- Status: Accepted
- Date: 2026-10-21
- Issue: [#454](https://github.com/guedesdiogo/kelpie/issues/454)
- Decided by the owner on #454:
  - the plan, on 2026-10-20: «aprovo»;
  - a turn no person typed, on 2026-10-20: «Waiting e perguntar»;
  - the design's questions, on 2026-10-21: «Dividir», «Só turnos sem pessoa» and «Não contam».
- Amends: [ADR-0013](0013-self-configuration.md), whose smaller changes run directly only in a turn that read no outside content.

## Context

#434's security review (PR #453) found a MEDIUM that cuts across Kelpie's tools. Text that Kelpie didn't write reaches the model through a tool's result, such as a VPS session's title or last reply from `vps_sessions`. A repository's issue or a model's reply can shape that text. In the same turn, it can steer a tool that changes something without the owner's confirmation:
- `memory_write`, whose notes load in later turns;
- `create_task` and `comment_task`;
- `create_subagent`;
- an agent's name, through `create_agent` and `rename_agent`.

**What guarded it:**
- the fence that marks the text as data, and, since #453, the list's line that says never to call a tool because of it. Both only advise the model;
- ADR-0013's confirmation, which covers only changes to access, cost or external accounts;
- #445's cap on the hand-offs of turns no person typed, 20 a day.

**The reference check** on #454 read Hermes Agent, ai-memory and invokta from their source:
- Hermes fences results by tool name, and asks for each tool of an untrusted MCP server that isn't read-only.
- Hermes also denies a flagged action in a turn no person started, and fails closed when no one can answer.
- invokta's `readOnly` and `destructive` hints only advise.
- None of them keeps a mark for the rest of a turn.

**The inventory** on #454, read from `main`:
- **Outside content:** only `vps_sessions` returns it today.
  - A task tool's result is Kelpie's fixed text.
  - Task news, comments and a subagent's output reach the model as Kelpie's notes, with another agent's words fenced.
  - A memory note is Kelpie's or the owner's.
  - A vault skill counts as the owner's edit (ADR-0058).
- **Tools that change something with no yes:** `memory_write`, `create_task`, `comment_task`, `create_subagent`, `delete_subagent`, `create_agent` and `rename_agent`, and a run's own `complete_task`, `wait_on_task` and `cancel_task`.
- **Tools that ask for the owner's own act:**
  - through a confirmation: `configure_agent`, `configure_models`, `set_claude_code`, `set_master`, `set_agent_chat` and `delete_agent`;
  - through a form: `connect_telegram`, `pair_telegram` and `connect_runner`;
  - through the proposal's page: `propose_agent_change`.
- **In a task's run,** no one answers a confirmation, and nothing ties the owner's answer on a task to a yes (ADR-0036 §4).

## Decision

### 1. Outside content, and its mark

- **Outside content** is text in a tool's result that neither Kelpie, its code or its agents, nor the owner wrote.
- **The tool marks the result** that holds it. The mark stays beside the result: history, the route and the model never see it.
- **`vps_sessions` marks its list** only when the list shows a session's own text: a title, a repository, a branch, a pull request's link or a last reply. An empty list or a failure holds none.
- **Other agents' words aren't outside content** («Não contam»): task news, comments, and a subagent's results. Their fences stay (ADR-0036 §6).

### 2. How long the mark lasts

- **The turn keeps it** from the first marked result to its end: across its rounds, on both routes, since the claude-code route's `tool_request` runs through the same loop, and past an eviction. It is written as soon as the result comes back.
- **A turn no person typed** (a note's or a task's, #345) starts marked while the history its requests send, since its checkpoint, holds a marked turn. It then counts as a marked turn too.
- **The owner's own turns** are marked only by what they read themselves («Só turnos sem pessoa»). History marking them would hold their memory writes until the next checkpoint, which comes only at 100,000 tokens.
- **A checkpoint ends it:** its summary never holds a tool's result (ADR-0025 §5).

### 3. What asks

- **Each tool says what it does:** it only reads, or it asks for the owner's own act before each change. A tool that says neither changes something with no yes, so a new tool asks until it says otherwise.
- **After the mark,** each call of such a tool goes through ADR-0013's gate, shaped by ADR-0026, in the turn's conversation:
  - the confirmation is for the command `tool:<name>` and the call's input;
  - Kelpie writes its summary in the conversation's language (ADR-0027): the tool's name and label, and its input with invisible characters written out;
  - with no yes, the call doesn't run, and its result says the change waits for the owner's confirmation;
  - a change too long to show in one bubble doesn't run either, and its result says so.
- **The tools that read or ask run as before,** and keep their own confirmations, forms and pages.
- **A run's own `complete_task`, `wait_on_task` and `cancel_task` don't ask:** they change only the run's own task, whose news another agent hears. #477 carries the mark into that news.
- **A note's turn** with no task asks in its conversation. Only a later message the owner writes confirms it (ADR-0028).

### 4. In a task's run

ADR-0013 holds: the task moves to Waiting and asks the requester («Waiting e perguntar»). Until the owner's yes can be bound to the held call, which #477 builds, the run fails closed:
- the call doesn't run;
- Kelpie's question goes on the task, through the run, as `wait_on_task` posts one. Kelpie writes it, in the conversation's language: the held call, why it waits, and that the owner can ask for the change in a message of their own;
- the run ends Waiting with `needs_input`, so the question reaches the owner through the agent that hears the task's news (ADR-0036 §4).

The owner's answer resumes the task, but confirms nothing (ADR-0036 §4). The next run is marked by its history, so the same change is held again. No tool offered in a task's run marks its results today, so this can't happen yet.

### 5. `vps_sessions` runs only in a turn the owner typed

- In a note's turn, it answers with words the model can pass on: the owner can ask for the sessions in a message of their own. A task's run never gets it (ADR-0057 §5).
- It stays in the turn's tools. Dropping it would change the tools with what started the turn. Earlier replies would then lose their native output (ADR-0025 §5), and each change would start a new claude-code session.

### 6. What it amends

- **[ADR-0013](0013-self-configuration.md):** "Smaller changes … run directly and are audited" holds only in a turn that read no outside content. After it, they ask, as in §3.
- **The effect on [ADR-0026](0026-confirmation-by-owner-act.md):** its yes, the typed code or the webchat's Confirm button, now also confirms a change §3 holds, under the same rules: the requester only, after the notice, once, within 10 minutes. ADR-0026's "smaller changes still run directly" holds as ADR-0013's does.

## Consequences

- **More confirmations,** but only after outside content: for the rest of a turn that read the VPS's sessions, and in the turns Kelpie's notes start until the next checkpoint.
- **The yes and the next call:**
  - The owner's code comes in a message of their own. That message's turn isn't marked unless it reads outside content again.
  - So the model's repeated call runs directly, and the code expires unused. A turn that reads the sessions again uses the code.
- **A task's run** that holds a change waits for the owner, and runs that follow are held again, until #477.
- **Cost:** none beyond the Workers Paid plan. The mark is one column on the conversation's turns, and no model call is added.
- **A rollback:** the column is add-only. Code from before it ignores the column, and its turns change directly again.
- **Tests cover:**
  - each changing tool asking after a marked result, and running on the owner's code;
  - a turn that read no outside content running as before;
  - the mark holding across rounds, the claude-code route and an eviction;
  - a note's turn asking, and the owner's own turn not;
  - a checkpoint ending the mark;
  - a task's run failing closed;
  - `vps_sessions` marking only its sessions' text, and refusing a turn no person typed;
  - every production tool's declared effect.

## Alternatives considered

- **Fence by tool name, as Hermes does.** Kelpie marks the result itself, so an empty list or a failure doesn't mark the turn.
- **Refuse the change in a turn no person typed,** as the plan's first step 4 said. The owner chose ADR-0013's Waiting and asking.
- **Stage the change for later review,** as Hermes's `write_approval` does. It needs a yes bound to the held call, which #477 builds.
- **Mark the owner's own turns by their history too.** It would hold their memory writes until a checkpoint, which comes only at 100,000 tokens.
- **Count other agents' words as outside content.** It would hold Master's orchestration after every piece of news, and need #477's yes now.
- **Drop `vps_sessions` from the tools of a turn no person typed.** It would change the tools with what started the turn (§5).
- **A regex scan as the gate, or a second model approving.** Both are heuristics, and the yes comes from a person (ADR-0013, ADR-0026).
- **An operator switch that lets such turns change things,** as Hermes's `cron_mode: approve`. It would undo the gate for every turn.

## References

- [ADR-0013](0013-self-configuration.md), [ADR-0025](0025-turn-tool-loop.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0028](0028-setup-step-notes.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0057](0057-vps-claude-code-sessions.md), [ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md)
- [#454](https://github.com/guedesdiogo/kelpie/issues/454): the reference check, the inventory, the design and the owner's decisions.
- [#477](https://github.com/guedesdiogo/kelpie/issues/477): the owner's yes for a change a task's run held.
- [#434](https://github.com/guedesdiogo/kelpie/issues/434) and [PR #453](https://github.com/guedesdiogo/kelpie/pull/453): the security review that found it.
- [`docs/admin-api.md`](../admin-api.md), "Outside content".
