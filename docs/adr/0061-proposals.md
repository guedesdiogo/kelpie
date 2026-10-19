# ADR-0061: Proposals come from where no configure_agent is, wait 72 hours on their page, and Kelpie tells their proposer

- Status: Accepted
- Date: 2026-10-19
- Issue: [#302](https://github.com/guedesdiogo/kelpie/issues/302)
- Decided by the owner on 2026-10-18, approving #302's plan and its ten defaults: «Aceito as 10 decisões como você recomendou, incluindo a mudança na 5 e a ADR-0060 no mesmo PR.» It was numbered 0060 then; #439's ADR took that number, so this is ADR-0061.
- Amends:
  - [ADR-0011](0011-agent-task-board.md): Kelpie comments on a task too, in its own words, as when it tells a proposal's outcome;
  - [ADR-0036](0036-agent-roles-models-and-subagents.md) §3: where the proposal tool is offered, how long a proposal waits, and its caps.

## Context

ADR-0036 §3 made a proposal a typed pending change about an agent, which an owner agent asks for:
- Kelpie tells the owner, in their conversation with Master, with a link to an admin API page.
- The owner's submission on that page is the yes (ADR-0026 §1).
- It expires after a time its story sets, and the agent that proposed it is told.

Since then, ADR-0048 gave Master every configuration tool. In its conversations with the owner, Master changes any agent with `configure_agent`, after the owner's confirmation. `set_agent_model` went: ADR-0048 rejected two tools for one change. A task's run holds no configuration tool, since no one there can confirm (#335).

That leaves two owner agents that can't change an agent they own:
- **a specialist with `spawn`**, about its own live subagent. It can only delete the subagent and make another;
- **Master in a task's run**, about a specialist or a subagent of its own.

The reference check on #302 read Hermes Agent, ai-memory and invokta. Kelpie adopts:
- ai-memory's typed rows with an append-only events table;
- a snapshot of the target, re-checked when the change applies;
- conditional updates, so a repeat changes nothing;
- notices written by the system, as Hermes's are.

Neither Hermes nor ai-memory expires a proposal, and neither tells the proposer the outcome.

## Decision

### 1. Who proposes, and what

| Proposer | Target | What it may propose |
|---|---|---|
| Master | a specialist | its trio (`model`), tools, remit, `spawn`, or its chat on its own |
| Master, or a specialist with `spawn` | a subagent of its own | its tier or effort, tools, remit, soul (`systemPrompt`) or skills |

- **A specialist's soul, rules and skills** stay in the vault (ADR-0020 §5), and the owner edits them in the webchat's editor (ADR-0058).
- **Master isn't a target,** and no proposal creates or deletes an agent.
- **One object per proposal.** A chat change is the Registry's, and settings are the target's AgentHost's, so the two never mix.
- **A proposed trio merges into the target's own,** area by area. The owner approves the whole result.

### 2. Where the tool is offered

- **`propose_agent_change` is offered only where the agent has no `configure_agent`:**
  - in every turn of a specialist that owns a subagent;
  - in Master's task runs.

  In its conversations with the owner, Master changes an agent with `configure_agent` instead, with the owner's confirmation. A subagent owns nothing, and never gets the tool.
- **Only the owner's own turn proposes:** the owner's role, reading all of their memory, as `create_task` checks.
- **Nothing exceeds what the proposer holds** (ADR-0036 §5, §6 rule 3):
  - for a subagent, its trio and tools stay within its creator's, as `create_subagent` checks, `complete_task` included;
  - a subagent's provider and memory follow its creator's, so only its tier and effort may be proposed;
  - for a specialist, the tools stay within those Master holds, its orchestration tools included (ADR-0050).

### 3. A proposal's life

- **It waits 72 hours,** then expires, and nothing changes.
- **Its statuses:** `pending`, `applying` while an approval runs, then `applied`, `refused`, `expired`, `conflict` or `void`.
- **The caps,** checked by the Registry in one synchronous step:
  - one pending per proposer and target;
  - three pending per proposer;
  - twenty pending in all;
  - ten made a day per proposer, whatever became of them.

  A proposal counts as pending until it expires, an approval still being applied included.
- **It applies only to what was proposed against.**
  - It records the fields as they were (`before`).
  - It applies only while the target still holds them: a target that changed since is a `conflict`, and so is one whose owner changed.
  - The comparison is JSON with sorted keys.
  - A change already in place counts as applied, so an approval that ran again is safe.
- **An approval that doesn't finish,** as when a service fails mid-way, is settled by the Registry's alarm five minutes later:
  - applied when the target holds the change, since a change applies in one step;
  - back to pending otherwise, for the owner to decide again while it hasn't expired;
  - when the target can't be read, still being applied, since unread isn't unapplied: tried again every five minutes, and every hour once the proposal expired.

  A proposal is claimed once, so no approval applies past its expiry. The page answers such an approval as taken, never as "nothing changed".
- **The applied change is audited on the target,** as `via: proposal:<id>`. Every step of a proposal is audited too, with the proposer, the person its turn acted for, and who decided.
- **Deleting an agent voids** the open proposals by it or about it.
- **The Registry's alarm** expires the proposals that are due, and tells each proposer that remains its outcome, in three tries at most.
- **Only the page decides.** No tool, note, task comment or JSON command approves or refuses a proposal.

### 4. Kelpie's notice

- **It goes to the owner's latest conversation with Master,** and starts a Master turn, so the notice follows a reply (ADR-0026 §2). That costs one model call per proposal.
- **The owner's bubble is a fixed text** in the conversation's language (ADR-0027):
  - it names the agents by id;
  - it lists the fields;
  - its one link is the page.

  It never quotes the agent's words.
- **The model gets a note of Kelpie's,** in English: what was proposed, that nothing changes without the owner, and the proposer's reason fenced as data. The note never holds the link, and tells the model not to write one or urge a decision.
- **One that expires before a reply is dropped.** When Master has no conversation yet, the proposal still waits on the admin API's list of proposals, and the tool says so.

### 5. The page

- **`GET /proposals`** lists the pending proposals.
- **`GET /proposals/<id>`** shows:
  - the proposer and the target by id;
  - the task the proposal came from;
  - the agent's reason, escaped, its invisible characters written out, and labeled as its own words;
  - each field as it is now and as proposed. A tools setting of `null`, every tool, says so in words, since it widens most;
  - how long it still waits.

  Its form offers Approve and Refuse. A target that changed since leaves only Refuse, and says why. It follows the design system's "Confirm an action" (`docs/design-system.md` 5.3), as a page with no script.
- **Its `POST` has the pairing page's checks:** the Access login, the owner, the same origin, and a form submission.
  - It answers 200 for applied or refused, 202 for an approval taken whose result didn't come back, 409 for a conflict, a void proposal or one already decided, 410 for an expired one, 404 for an unknown one, and 503 when a service didn't answer.
  - A repeat is never a 500, and a `GET` changes nothing.
- **There is no CSRF token:** the same-origin check is the guard, as on the pairing page. The page runs no script and takes only a form.

### 6. The proposer hears the outcome

- **A proposal made in a task's run** is told as Kelpie's comment on that task, of author `kelpie`.
  - It resumes a task waiting on other work (`dependency`), as the tool tells the run to wait, and reaches a running one's run. A task waiting for the owner's answer, or after two failures, keeps waiting for a person.
  - An outcome told again comments once.
  - The run's input lists Kelpie's comments as Kelpie's own, never fenced as another agent's words.
- **Otherwise,** it is a note of Kelpie's in the proposer's latest conversation with the owner.
- **Each outcome has its note:** applied, refused, expired, conflict, or void when an agent it named was deleted. Each says nothing changed unless it was applied, and not to propose the same again unless the need is new.
- **A proposer deleted since** hears nothing. A void that a deletion caused waits a minute, so the rest of a deletion's cascade goes first.

### 7. Amendments

- **[ADR-0011](0011-agent-task-board.md):** Kelpie also comments on a task, in its own words, as when it tells a proposal's outcome. Its comment resumes only a task waiting on other work, and its step in the task's history has no actor, as Kelpie's other steps don't.
- **[ADR-0036](0036-agent-roles-models-and-subagents.md) §3:**
  - the proposal tool is offered where `configure_agent` isn't (§2 above);
  - a proposal waits 72 hours, within the caps of §3 above.

## Consequences

- **An abandoned approval is labeled by the target's values,** not by the target's audit. When another approved change to the same fields lands before the alarm reads the target, the first may read as expired without its change applied, or as applied, though the target's audit shows the first one's `via: proposal:<id>`. The target's state is always one the owner approved. An approval whose target stays unreadable has no end until the target is deleted, and its proposer isn't told meanwhile.
- **What the owner sees:**
  - a notice in their conversation with Master, after its reply, with the page's link;
  - the page, where the whole change shows before they decide;
  - the list of what waits, at `/proposals`.
- **Cost:**
  - each proposal starts one Master turn;
  - each outcome told in a conversation starts one of the proposer's;
  - the caps bound both: ten proposals a day per proposer, twenty pending in all.
- **A rollback:**
  - the tables are add-only;
  - an alarm that fires on a release without `alarm()` is dropped with a warning, not retried (workerd [`ServiceWorkerGlobalScope::runAlarm`](https://github.com/cloudflare/workerd/blob/900cbea9f44f2e5711e7dd4b130011b82e086f6b/src/workerd/api/global-scope.c%2B%2B#L683-L689)), so the Registry sets it again as it starts;
  - a page or decision reached meanwhile finds a release that doesn't know proposals, and nothing applies.
- **Related follow-ups:**
  - #350 can reuse Kelpie's task comment for task news;
  - #338 can reuse the lookup of the owner's latest conversation with Master;
  - a proposal applies nothing, so it stays safe in whatever turns #345 lets hand work off.
- **Tests cover:**
  - that a proposal never applies without the owner's act on its page;
  - that an expired, refused, stale or void one changes nothing, and a repeat nothing more;
  - the caps;
  - the notice, which no model sees;
  - the outcome on the task, which resumes it;
  - one flow from end to end, with the real Registry, AgentHosts and conversations.

## Alternatives considered

- **Offer the tool in Master's conversations beside `configure_agent`.** Two tools for one change, which ADR-0048 rejected for `set_agent_model`.
- **Send the notice as Kelpie's bubble with no Master turn.** It saves a model call, but ADR-0026 §2 puts Kelpie's links after the agent's reply.
- **Tell a task-run proposer in a conversation.** A waiting task resumes only with an answer on the task.
- **Comment as the proposer itself.** An agent's own comment never resumes its task, and the task's history would credit it with Kelpie's words.
- **Never expire, as Hermes and ai-memory don't.** A proposal the owner never sees would hold a cap forever.
- **An RFC 8785 fingerprint, as invokta's.** The settings are typed, so JSON with sorted keys compares them as well.
- **A CSRF token.** The page has no script and takes only its own form, so the same-origin check guards it, as it does the pairing page.

## References

- [ADR-0011](0011-agent-task-board.md), [ADR-0020](0020-shared-memory-engine.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0048](0048-master-configures-kelpie.md), [ADR-0050](0050-master-orchestration-tools.md), [ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md)
- [#302](https://github.com/guedesdiogo/kelpie/issues/302): the reference check, the plan and the owner's decisions.
- [`docs/admin-api.md`](../admin-api.md), "Proposals".
