# ADR-0050: Master always holds the tools it orchestrates Kelpie with

- Status: Accepted
- Date: 2026-10-16
- Issue: [#391](https://github.com/guedesdiogo/kelpie/issues/391)
- Decided by the owner on 2026-10-16: «as tools que são padrões para orquestrar a plataforma/harness, precisam ficar por padrao obrigatorias para o agente master»

## Context

ADR-0048 made Master the one agent that configures Kelpie. Every agent's `tools` setting is an allowlist: a turn is offered only the tools it names, or all of them when it is `null` (ADR-0036 §3, #290). That allowlist applied to Master's orchestration tools too.

ADR-0048 §2 guarded against the obvious lockout:
- `configure_agent` refused a list for Master that left out a configuration tool;
- `set_main_agent` refused an agent whose list left them out.

The reviews of #386 found the gap the guards can't close: a list stored before them still strips Master's tools, with only the admin API as a way back. The owner then asked that the platform's orchestration tools be mandatory for Master.

The reference check is on #391. Hermes Agent's [`bundle_non_core_tools`](https://github.com/NousResearch/hermes-agent/blob/e6899c8090da3bd48c829893e4103ce989d3482d/toolsets.py#L321-L336) keeps a fixed core that disabling a bundle "must not strip". That core includes its task board, `delegate_task` and `cronjob_manage`.

## Decision

- **Master's orchestration tools:**
  - the 14 configuration tools of ADR-0048 §1;
  - `create_subagent` and `delete_subagent`;
  - the board's `create_task`, `comment_task`, `cancel_task`, `wait_on_task` and `complete_task`.

  They are `MASTER_TOOLS` in `conversation-runtime`.
- **Master always holds them.** Its `tools` setting narrows only its other tools, such as memory. That applies to a list stored before this decision, to one Master writes, and to the list of an agent that becomes Master.
- **What Master holds is what its subagents are limited by.** A subagent's tools stay a subset of its creator's (ADR-0036 §5), counting the orchestration tools Master always holds. So a narrowed Master still gives its subagents the task tools they need to finish a task.
- **The providers' own gates stay:**
  - owner-only, and Kelpie's confirmation for changes;
  - none of the configuration tools in a task's run (#335);
  - a task's run holding the task tools for its own task;
  - Master owning the agents it hands tasks to.
- **The ADR-0048 §2 guards go:**
  - `configure_agent` takes any valid `tools` list for Master, with the owner's confirmation;
  - `set_main_agent` takes an agent whatever its list.
- **Other roles don't change.** A specialist's list narrows everything it is given, and a subagent gets only a subagent's tools.

### Amendments

- **[ADR-0048](0048-master-configures-kelpie.md) §2:** Kelpie keeps an agent that configures it in chat because Master always holds its orchestration tools, not because the two tools refuse a list.
- **[ADR-0036](0036-agent-roles-models-and-subagents.md) §5:** a subagent's tools are a subset of what its creator holds, a Master creator's orchestration tools included.

## Consequences

- **The admin API is no longer needed to recover a narrowed Master's configuration tools,** as it was for a list stored before ADR-0048.
- **The owner can't narrow Master out of orchestration** through `tools`. They narrow only Master's other tools.
- **Tests cover:**
  - a direct turn of a Master whose list names only `memory_search` is offered every orchestration tool, and only `memory_search` of the others;
  - a specialist with the same list gets only `memory_search`;
  - a narrowed Master's subagent keeps its task tools;
  - `configure_agent` and `set_main_agent` take any list.

## Alternatives considered

- **Keep ADR-0048 §2's guards.** They miss a list stored before them, and a refusal is one more thing for Master to explain.
- **Make every tool mandatory for Master.** The owner can still want Master without, say, memory writes. Only orchestration is the platform's.
- **Hide the orchestration tools from the `tools` setting's values.** The setting is still a plain list, so a stored one keeps working. Master holding the tools is decided where a turn's tools are filtered.

## References

- [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0048](0048-master-configures-kelpie.md)
- [#391](https://github.com/guedesdiogo/kelpie/issues/391), with the reference check; [#386](https://github.com/guedesdiogo/kelpie/pull/386)'s reviews
- Hermes Agent at [`e6899c8`](https://github.com/NousResearch/hermes-agent/tree/e6899c8090da3bd48c829893e4103ce989d3482d): [`_HERMES_CORE_TOOLS`](https://github.com/NousResearch/hermes-agent/blob/e6899c8090da3bd48c829893e4103ce989d3482d/toolsets.py#L11-L39), [`bundle_non_core_tools`](https://github.com/NousResearch/hermes-agent/blob/e6899c8090da3bd48c829893e4103ce989d3482d/toolsets.py#L321-L336)
