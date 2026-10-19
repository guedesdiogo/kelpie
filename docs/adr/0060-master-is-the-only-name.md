# ADR-0060: Master is the role's only name, and nothing calls the setup agent

- Status: Accepted
- Date: 2026-10-19
- Issue: [#439](https://github.com/guedesdiogo/kelpie/issues/439)
- Decided by the owner on 2026-10-18: «nada de agente setup mais, e nem agente principal/main, apenas master»

## Context

#343 named the main agent's role Master in Kelpie's texts. ADR-0036 §7 recorded that "`main` stays its value in the Registry, and the code keeps its names". Two days after ADR-0048, a sweep of `main` at `73f0fcf` found that the owner and the models still met the old names:
- **the webchat editor and roster** showed Master's specialty as «main» in English and «principal» in Portuguese and Spanish;
- **the model's tool** was `set_main_agent`, and `list_agents` showed the role `main`;
- **the admin API** had `/commands/setMainAgent`, and the role value `main` in its JSON.

The sweep also found two places that still called the setup agent ADR-0048 retired:
- **the runner form's wait** lived on its `AgentHost`, and the admin API reported the form there (ADR-0048 §4);
- **the deploy probe** woke that `AgentHost`.

No reference project covers renaming an agent role.

## Decision

### 1. Master is the role's only name

- **The role's value is `master`** wherever code reads it: `AgentRole`, the Registry's entries, `list_agents`, the admin API's JSON, and the webchat's agent list.
- **The names follow it:**
  - the command is `setMaster` and the admin API route `/commands/setMaster`;
  - the model's tool is `set_master`;
  - the Registry's method is `setMaster`.
- **Master's specialty reads «Master** in English, Portuguese and Spanish, and so does the locked field's help.
- **The texts, docs and code comments** say Master, never "main agent" or "agente principal".

### 2. The database keeps its stored values

- The Registry's `role` column keeps the value `main` for Master, and the audit keeps the action `agent.main_set`.
- The Registry maps the stored role to `master` when it reads a row, and writes `main` when it makes one Master. No caller sees the stored value.
- Rewriting the column would make a rollback barrier (ADR-0029), so the mapping keeps the migrations add-only. Rewriting it is left for when the owner wants a barrier for it.
- A role cached before this decision reads as `master` too. That covers an `AgentHost`'s last-seen identity and a conversation's roster, through the same `readRole` the Registry uses.

### 3. Nothing calls the setup agent

- **`connect_runner` keeps the wait on its caller's own `AgentHost`,** which is Master's.
- **The admin API reports the runner form to the agent that is Master when the form is submitted,** read from the Registry.
  - With no Master, the runner is stored and nobody is told.
  - A Master changed while the form was open misses the note, though the form still works.
- **The deploy probe wakes only the agents the Registry lists.**
- **The retired id stays a guard over leftover data,** as `RETIRED_AGENT_ID`:
  - the Registry never lists it;
  - `admit` refuses it;
  - a socket to it closes;
  - no agent may take it.

  Its row and storage stay for a rollback, as ADR-0048 §3 says.

### Amendments

- **[ADR-0036](0036-agent-roles-models-and-subagents.md) §7:** the role is `master` in the code and the API too. Only the database keeps `main`.
- **[ADR-0048](0048-master-configures-kelpie.md) §4:** the runner's wait is on Master's `AgentHost`, and the deploy probe no longer wakes the retired id.

## Consequences

- **A script calling `/commands/setMainAgent` gets 404,** and a confirmation opened before the deploy for `setMainAgent` has to be asked again.
- **A rollback reads the database as before,** since the stored values didn't change.
- **During the deploy,** for the minutes between `conversation-runtime` and the Workers deployed after it:
  - the old `ingress` names no agent Master, so the webchat opens the first agent it lists;
  - the old admin API's `setMainAgent` fails;
  - a webchat tab left open across the deploy shows no Master until it reloads.
- **A runner form opened in the 15 minutes before the deploy** kept its wait on the retired id's `AgentHost`, so its note is lost. The owner then says they're done.
- **Tests cover:**
  - the Registry's mapping and its stored value;
  - `set_master` and the specialty «Master» in three languages;
  - the runner's wait and report through Master, including with no Master;
  - a probe that wakes only listed agents;
  - a test that the skill, tools and labels never say "main agent", "agente principal", `main` or "setup agent".

## Alternatives considered

- **Rewrite the stored role to `master` in a migration.** It is a rollback barrier, and needs the owner's agreement (ADR-0029). The mapping gives the same names everywhere a person or model reads them.
- **Keep the runner's wait on the retired id,** as ADR-0048 §4 did. That keeps calling the setup agent, which the owner ruled out. The note's one loss, when Master changes while a form is open, is rare and costs only the note.
- **Keep `setMainAgent` as an alias of `setMaster`.** That is a second name for one command, which this decision removes.

## References

- [ADR-0029](0029-continuous-deployment-and-rollback.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0048](0048-master-configures-kelpie.md)
- [#343](https://github.com/guedesdiogo/kelpie/issues/343), [#439](https://github.com/guedesdiogo/kelpie/issues/439)
