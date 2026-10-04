# ADR-0011: Agents run and report their work on Kelpie's own task board

- Status: Accepted
- Date: 2026-10-03
- Issue: [#44](https://github.com/guedesdiogo/kelpie/issues/44)

## Context

People need to see everything agents do in the background, and to queue work for them, without waiting for a chat turn. The first proposal used GitHub Issues as tasks and a GitHub Project as the board, with a heartbeat to pick up assigned work. Three facts limited it:
- GitHub pages can't be framed (`x-frame-options: deny`).
- GitHub Apps can't access user-owned Projects v2.
- `projects_v2_item` webhooks exist only for organizations.

The owner rejected it for a more basic reason: anyone can edit an issue by hand, and that would interfere with the agent's own management of its work. The owner asked instead for a Kelpie board that:
- the agent uses to create and manage its own activities, whether or not they came from chat;
- people use to create tasks and to comment on them;
- people can never use to move a task's status once the agent has put it in progress;
- treats Backlog as drafting and To do as release, with tasks scheduled for a date or time waiting for it;
- shows every task the agent is executing.

## Decision

- **Statuses:** Backlog, To do, In progress, Waiting (the agent needs a person: input or approval), Done, Cancelled.
- **What people can do,** if they have a grant on the agent (ADR-0004):
  - create tasks in Backlog or To do;
  - edit a task while it is in Backlog or To do;
  - move a task between Backlog and To do;
  - comment at any time.

  Once a task reaches In progress, people can't change its status.
- **What the agent does:**
  - creates a task for every piece of background work it runs, including work requested in chat;
  - owns every transition from In progress on;
  - reads people's comments as input;
  - moves the task to Waiting when it needs someone;
  - ends it in Done or Cancelled, with a result.
- **Pickup:** a task in To do is eligible at once, unless it has a scheduled start; then it becomes eligible at that time. The agent's `AgentHost` Durable Object (ADR-0002) picks eligible tasks in two ways:
  - right away, when a task enters To do (the admin API notifies it);
  - on its heartbeat alarm, which also fires at the next scheduled start.

  No model is called unless there is a task to run.
- **Claiming and running:** the agent claims a task with a lease held in `AgentHost`, then moves it to In progress. Long tasks run as Workflows. How many tasks an agent runs at once is a per-agent setting.
- **Authority:**
  - `AgentHost` is the single writer of task status and enforces the rules above;
  - people's actions reach it through the admin API;
  - tasks, comments and status changes are projected into Postgres for the board and for audit (ADR-0007).
- **Comments are the task's history.** Every comment is stored on the task with its author, time and source: the board, or chat. When someone comments on a task in chat, the agent attaches that message to the task as a comment, linked to the conversation. The agent's own progress notes are comments too, so the task reads as a complete history.
- **Stop requests:** the owner or an admin can *request* that the agent stop a running task. The agent honors the request and moves the task to Cancelled, so status stays agent-owned while people keep a way to halt work that went wrong. Members can only comment.
- **Pluggable sources:** tasks enter through a `TaskSource` port, with the internal board first. External sources, such as GitHub Issues, may be added later as one-way imports into the board, never as the place where status is managed.
- **Personal data:** tasks and comments can contain personal data, so they live in Postgres and Durable Objects, never in git (ADR-0006). The erasure workflow covers them.

## Consequences

- People see all background work, and dragging a card can't corrupt an agent's in-flight state.
- Kelpie builds its own board view instead of reusing GitHub's. The task model, API and heartbeat land in phase 2 (#18), when agents gain tools and start working in the background. The board UI lands in phase 3 (#19), with the management UI.
- The Context Store still uses GitHub (ADR-0005), but it only needs repository access, which a GitHub App has on user accounts too. Instances don't need a GitHub organization.

## Open points

- Recurring tasks (routines, as in Hermes Bot Mode) as a later extension of scheduled starts.

## Alternatives considered

- **GitHub Issues as tasks with a Project board.** Rejected by the owner, because manual edits interfere with agent-managed status. It is also limited by the framing, App-access and webhook facts above.
- **A queue without a board.** No visibility into background work.

## References

- [Issue #44](https://github.com/guedesdiogo/kelpie/issues/44), with the GitHub facts and the owner's decision
- [ADR-0002](0002-runtime-foundation.md), [ADR-0004](0004-access-control.md), [ADR-0006](0006-personal-data-storage.md), [ADR-0007](0007-system-of-record-database.md)
