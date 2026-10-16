# ADR-0039: An agent's routines are Markdown files in its vault folder, and each fire creates a task on its board

- Status: Accepted
- Date: 2026-10-14
- Issue: [#306](https://github.com/guedesdiogo/kelpie/issues/306)
- Decided by the owner on 2026-10-13, answering research note 10's Q1: «Q1: sim»
- Amended by: [ADR-0047](0047-master-configures-kelpie.md), Master, not Admin, may call the routine commands for another agent

## Context

**Routines have no home yet.** ADR-0011 left them as an open point: "Recurring tasks (routines, as in Hermes Bot Mode) as a later extension of scheduled starts." Elsewhere:
- ADR-0002 puts schedules on the agent's `AgentHost`;
- ADR-0013 counts schedules among the configuration changes that are small enough to run directly, audited;
- no routine exists in code: the only timers are internal alarms (note 10 §4).

**Research note 10 found a format** in Vercel's eve. A routine there is a Markdown file in the agent's folder, `schedules/<name>.md`, with `cron` in its frontmatter and the prompt as its body ([`markdown.ts#L94-L118`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/internal/helpers/markdown.ts#L94-L118)). It has three limits:
- its file form runs in UTC only;
- a fire has no channel, so it can't ask for approval;
- it runs a bare turn, with no record beyond its trace.

**Hermes** keeps an agent's cron in the agent's own directory too, as one `jobs.json`, and a cron session can't create cron (note 01).

The note asked whether a Kelpie routine could be such a file, with a time zone, each fire creating a task, and the agent writing its own routines directly, as it writes memory. The owner answered «sim».

## Decision

### 1. Where and what

**A routine is `agents/<agent-id>/schedules/<name>.md` in the vault.**
- Its name is the file's name without `.md`, as eve names it by path.
- Only files directly in `schedules/` are routines.

**Its frontmatter:**
- `cron`, required: five fields, minute to weekday.
- `timezone`, optional: an IANA name such as `America/Sao_Paulo`. Without it, the owner's time zone applies (the `setTimeZone` command's setting), else UTC.
- `paused`, optional: `true` stops its fires without removing it.
- Any other key is ignored, so Obsidian's `tags` or `aliases` do no harm.

**Its body** is the work, written as a task for the agent:
- its `# Title` heading, or else its name, becomes the task's title;
- the text becomes the task's description.

```markdown
---
cron: "0 9 * * 1"
timezone: America/Sao_Paulo
---

# Weekly summary

Summarize last week's notes under areas/work/ and list what is still open.
```

### 2. How it fires

- **Each fire creates a task** in To do on the agent's board (ADR-0011).
  - The task records the routine's path as its source.
  - **Its requester is the owner.** While Kelpie is single-player (ADR-0015), the owner is the one asked when the task needs a person.
  - It is picked up like any task in To do, at once.
- **The agent's `AgentHost` keeps the timer.** It reads its routines from the Context Store and sets its alarm to the next fire. The alarm is re-armed:
  - on an edit that reaches the vault through the push webhook or the reconcile;
  - on a change to the owner's time zone.
- **No pile-up.** While the routine's previous task is still open (Backlog, To do, In progress or Waiting), a fire is skipped and noted as a comment on that task.
- **No catch-up.** A late alarm still fires. Fires missed entirely, while Kelpie was down, create at most one task between them.
- **Operational state stays out of the vault,** as ADR-0016 requires. When a routine last fired, its next fire and its skipped fires live on `AgentHost`. Its tasks live where ADR-0011 puts them.

### 3. Bounds

- **Fires at least 15 minutes apart.** A routine with two consecutive fires closer than that, in its own time zone, doesn't fire at all.
- **At most 10 active routines per agent.** Paused ones don't count. Past ten, the extra routines, last in name order, don't fire.
- **A routine can't make routines.** A task created by a routine can't create, change, pause or remove a routine, as a cron session can't in Hermes. Text a routine's run reads can't plant recurring work.
- **Subagents have none.** Their definition lives on their `AgentHost`, not in the vault (ADR-0036 §5 and §7).

### 4. Who writes routines

- **The owner, anywhere:** GitHub, Obsidian or any editor. It counts as a manual edit (ADR-0016).
- **Kelpie, only through configuration commands** (ADR-0013). A command that creates, changes, pauses or removes a routine writes its file through the Context Store.
  - It has the commands' permission checks.
  - It is audited as "requested by X through agent Y".
  - The commit names the agent in its `Kelpie-Agent` trailer.
- **An agent may call those commands for its own routines,** at the user's request or on its own.
  - There is no confirmation and no pull request: it is a smaller change in ADR-0013's sense.
  - ADR-0020 §5's approval covers only the persona, rules and skills.
- **Admin may call them for another agent,** at the user's request.
- **Kelpie announces an agent's change.**
  - When an agent creates, changes, pauses or removes a routine, Kelpie sends a notice of its own (ADR-0036 §6 rule 4). It names the routine and its next fire, in the conversation's language (ADR-0027).
  - **Where:** to the conversation the change was asked in. A change made outside a conversation, by a task or by a specialist whose chat is off, goes to the user's conversation with the main agent, where ADR-0036 sends proposals.
  - The owner's own edits are not announced.

### 5. A routine that doesn't parse

These don't fire:
- a missing or invalid `cron`;
- an unknown `timezone`;
- fires closer than 15 minutes;
- routines past the tenth.

Each appears in the vault's lint report with the reason, as a broken skill does in #305. A file held with conflict markers keeps its version from before the conflict, as a persona does.

### 6. Amendments

- **[ADR-0002](0002-runtime-foundation.md):** `AgentHost` holds a routine's timer and its operational state. The definition lives in the vault.
- **[ADR-0011](0011-agent-task-board.md):** the open point on routines is settled. A task may be created by a routine, which is then recorded as its source, with the owner as its requester.
- **[ADR-0013](0013-self-configuration.md):** schedules are routines kept as files in the vault. The commands that set them write those files, and a change still runs directly and is audited.
- **[ADR-0016](0016-vault-second-brain.md):** the layout gains `agents/<agent-id>/schedules/`. Kelpie writes there through configuration commands, with no pull request.

## Consequences

- **The owner reads and edits routines as plain files,** next to the agent's persona and skills, and git keeps their history. Removing Kelpie loses no routine, though nothing fires them without it.
- **Each fire costs a task's model calls.** That is the cost of work the owner, or an agent at the owner's request or on its own, scheduled. Four things bound and show it:
  - the 15-minute floor;
  - the cap of 10;
  - the no-pile-up rule;
  - the weekly report (#269).

  Kelpie's notice tells the owner of every routine an agent sets, and pausing one is one line.
- **Prompt injection gains a target.** Text an agent reads could talk it into a routine. The no-routines-from-routines rule, Kelpie's notice and the cap limit what that achieves.
- **Routines need the task board.** They land after #54's task model and heartbeat, in their own story. That story also:
  - adds `schedules/` to the vault's README;
  - adds the configuration commands, with the Context Store's path rules for them.
- **Time zones need a cron library that handles them,** across daylight-saving changes, on Workers.

## Alternatives considered

- **Routines only as configuration on `AgentHost`.** The note offered this as Q1's alternative. The owner chose the file, which can be read and edited without Kelpie.
- **The agent writing the file directly, as memory.** That would skip ADR-0013's single path for configuration, with its checks and audit. The command writes the same file.
- **eve's TypeScript schedules.** Code in the vault is ruled out (note 10, Avoid 1).
- **One `jobs.json` per agent, as Hermes does.** JSON is harder to read and edit, and one file for every job merges worse than a file per routine.
- **A bare turn per fire, as eve does.** It leaves no record on the board, and nobody can follow, comment on or stop it.

## References

- [Research note 10](../research/10-eve.md), Adapt 1 and Q1
- [ADR-0002](0002-runtime-foundation.md), [ADR-0011](0011-agent-task-board.md), [ADR-0013](0013-self-configuration.md), [ADR-0015](0015-single-player-first.md), [ADR-0016](0016-vault-second-brain.md), [ADR-0020](0020-shared-memory-engine.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0036](0036-agent-roles-models-and-subagents.md)
- eve's schedule format: [`internal/helpers/markdown.ts#L94-L118`](https://github.com/vercel/eve/blob/624be476e38cb40a4a21ec1ff7ed397cb389c047/packages/eve/src/internal/helpers/markdown.ts#L94-L118)
- Hermes's cron rules: [note 01](../research/01-hermes-agent-and-bot-mode.md), §7
