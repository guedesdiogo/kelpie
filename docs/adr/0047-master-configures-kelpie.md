# ADR-0047: Master configures Kelpie, and the setup agent goes

- Status: Accepted
- Date: 2026-10-16
- Issue: [#382](https://github.com/guedesdiogo/kelpie/issues/382)
- Decided by the owner on 2026-10-16: «O agente principal e o agente setup serão um só. Vamos remover o conceito de agente setup e passar as permissões e responsabilidades do agente setup para o agente principal.»

## Context

The owner, asking to "simplify even more", merged two built-in agents into one. Until now (`main` at `e3bfa04`), two of them chatted with the owner:
- **Admin, the setup agent** (id `setup`; Story 3.11, ADR-0013, ADR-0036 §1). Only it held the configuration tools: agents, the instance's models, Master, chat, deletion, Telegram bots and pairing, and the VPS runner.
- **Master** (ADR-0036 §1, #343), the agent the owner talks to. Its one configuration tool was `set_agent_model`, for other agents' trios (#289). ADR-0036 §3 let no agent but Admin change its own trio.

[#274](https://github.com/guedesdiogo/kelpie/issues/274) planned to rename the setup agent Admin and widen it to infrastructure. This decision supersedes it.

The reference check is on #382. It read the source of Hermes Agent, Hermes-Bot-Mode, ai-memory and invokta:
- **Hermes runs first-run setup in its main agent,** adding the setup toolset only while onboarding runs. No project has a separate configuration agent.
- **Each gates configuration in code:** by the caller's level (ai-memory), by `allow_admin_from` (Hermes), or by access the engine enforces (invokta).
- **Hermes keeps its approval policy out of the agent's reach.**

## Decision

### 1. One agent faces the owner

- **Master is the one built-in agent.** The roles are `main` (Master), `specialist` and `subagent`. Admin's role goes.
- **Master holds every configuration tool the setup agent held:**
  - `list_agents`, `get_agent`, `create_agent`, `rename_agent`, `configure_agent` and `delete_agent`;
  - `get_models` and `configure_models`;
  - `set_main_agent` and `set_agent_chat`;
  - `connect_telegram` and `pair_telegram`;
  - `connect_runner` and `runner_status`.

  They run the same commands as the admin API, as the owner, through Master (`via: agent:<Master's id>`).
- **The gates don't change:**
  - every tool is owner-only;
  - a change to an agent's settings, the instance's models, Master or chat, and a deletion, waits for Kelpie's own confirmation (ADR-0026);
  - Kelpie sends each secure form's and the pairing page's link itself, and the owner's act on the page is the yes;
  - a secret never passes through the chat (ADR-0013).

  The confirmations are code, not a setting, so Master can't turn them off.
- **The tools reach Telegram too,** since Master answers there.
  - The setup agent was reached in the webchat, behind Cloudflare Access. On Telegram, the owner's paired account confirms with the typed code, as ADR-0026 already allows.
  - So a deletion or a model change asked on Telegram rests on that account's security.
  - The secure forms and the pairing page stay behind Access.
- **The tools follow the role.** The agent the Registry calls `main` has them, checked when a turn lists them and again when one runs. When `set_main_agent` makes another agent Master, the previous Master's next call is refused.
- **Not in a task's run:** a task's conversation has no owner to confirm anything (#335).
- **Master's prompt carries the setup agent's guidance** as a built-in `configure-kelpie` skill, whatever persona the owner gives Master, as the `create-subagent` skill does for `spawn`.
- **`set_agent_model` goes.** `configure_agent` covers it, and its `model` replaces the agent's whole model settings, which the confirmation shows before and after.
- **Specialists and subagents never get configuration tools.**

### 2. Who changes what

ADR-0036 §3's table moves from Admin to Master:

| Change | Who may make it | The yes |
|---|---|---|
| Any agent's trio, Master's own included | Master, when the owner asks or agrees with its suggestion | the owner's confirmation |
| Another agent's soul, rules, skills or remit | Master, at the owner's request | as ADR-0013 and ADR-0020 §5 say |
| Another agent's tools, chat access or `spawn` | Master, at the owner's request | the owner's confirmation |
| Any of the three rows above, when an agent asks for it | the owner agent proposes; the configuration commands apply it | the owner's approval of the proposal |
| Create or delete a specialist | Master | the owner's confirmation |
| Create or delete a subagent | its creator, within ADR-0036 §5's limits, or the owner through Master | none: turning `spawn` on is the owner's standing yes |

The other rows of ADR-0036 §3 stand. That includes a subagent's trio at its creation, and an agent's own persona, rules and skills.

- **No agent but Master changes its own trio,** and only with the owner's confirmation. ADR-0036 gave the owner's reason: an agent that lowered its own cost couldn't raise it back. That still holds:
  - Master keeps `configure_agent` at any tier;
  - the admin API's `configureAgent` can always raise it.
- **Kelpie always keeps an agent that configures it in chat.**
  - `configure_agent` refuses a tools list for Master that leaves out a configuration tool.
  - `set_main_agent` refuses an agent whose tools list leaves them out.
  - The admin API can still change either.

### 3. The setup agent retires without a destructive migration

- **The Registry stops listing the `setup` row and answering for it.** `get` and `list` skip it, so `setMainAgent`, `setAgentChat` and `deleteAgent` don't know it, and the webchat doesn't list it.
- **Nothing reaches it:**
  - the Directory refuses it at `admit` with `no_grant`, whatever the Registry says, so a Telegram bot connected to it reaches nothing;
  - a webchat socket opened to it before the deploy closes at its next message.
- **A bot already connected to it keeps its token and webhook,** since no command deletes the retired agent. Its owner revokes the token with BotFather.
- **Its row and its `AgentHost`'s storage stay,** so a rollback finds them as they were (ADR-0029). Its id stays reserved: `createAgent` and the Registry refuse it.
- **Its old conversations with the owner stay** where nothing reaches them. Erasing them waits until no rollback can reach a build from before this ADR.

### 4. The runner's form keeps its fixed wait

The runner is the instance's, not one agent's.
- `connect_runner` keeps the form's wait on the `AgentHost` under the retired id, and the admin API keeps reporting the form there (#328).
- The deploy's probe still wakes that `AgentHost` (ADR-0033), though the Registry doesn't list it.
- The note reaches the conversation that sent the form, as ADR-0028 says, whichever agent is Master by then.

### 5. An instance with no Master

An instance with no agent in the role `main` has no agent with the configuration tools. That is one that had agents before #288 and never picked one. The owner picks one with the admin API's `setMainAgent`.

### 6. Amendments

- **[ADR-0013](0013-self-configuration.md):** the owner configures Kelpie by talking to Master, not to a setup agent. The bootstrap then leads to Master in the webchat.
- **[ADR-0036](0036-agent-roles-models-and-subagents.md):**
  - §1: the Admin role goes, and Master can't be deleted;
  - §3: Master takes Admin's place in the table (§2 above);
  - §5: only Master turns `spawn` on for another agent, and the owner deletes a subagent through Master;
  - §6:
    - rule 2: the owner talks to Master;
    - rule 5: no agent but Master changes its own trio;
    - rule 8: a basic user sees one default trio and Master.
- **[ADR-0039](0039-routines-as-vault-files.md):** Master, not Admin, may call the routine commands for another agent, at the owner's request.

## Consequences

- **What the owner sees:** one agent, Master, in the webchat and on Telegram, which also configures Kelpie. The webchat no longer lists Setup.
- **[Story 5.28 (#383)](https://github.com/guedesdiogo/kelpie/issues/383) implements it.** Its tests cover:
  - that the configuration tools reach only Master, follow the role when it moves, and stay off a task's run;
  - that the Registry hides the retired row and keeps it;
  - that the Directory refuses the retired id, and an open socket to it closes;
  - that Master can't lose the configuration tools through a tools list or `set_main_agent`;
  - that the deploy's probe still wakes the retired id's `AgentHost`;
  - that only Master's prompt carries the `configure-kelpie` skill;
  - that Master changes its own model only after the owner's confirmation.
- **Two issues change:**
  - #274 is superseded;
  - the cost reports of #269 go to the owner's conversation with Master.
- **The handoff eval (#287) runs with Master's prompt,** which now carries the `configure-kelpie` skill, so its rate should be measured again.
- **Text from other agents now reaches a turn that holds configuration tools.**
  - A specialist's task news reaches the owner's conversation with Master as Kelpie's note. The setup agent never got task news.
  - So that text can steer a change that ADR-0013 lets run without a yes, such as `create_agent` or `rename_agent`. A rename also changes the name a later confirmation quotes, beside the id.
  - A follow-up has Kelpie announce those changes, as it does a subagent's creation.

## Alternatives considered

- **Keep Admin as its own agent, renamed (#274).** The owner chose one agent.
- **Delete the setup agent's row and storage in a migration.** That rewrites data, so it would need a rollback barrier and the owner's agreement. Hiding the row is add-only.
- **Keep `set_agent_model` beside `configure_agent`.** Two tools for one change leave the model choosing between them, and the confirmation already shows the whole result.
- **Keep ADR-0036's rule that Master can't change its own trio.** Then no agent could, and the owner asked that Admin's permissions, its own trio included, move to Master.
- **Report the runner's form to whichever agent is Master.** A Master changed between sending the form and its submission would miss the note. The fixed id keeps ADR-0028's promise.
- **Have the Directory refuse every agent the Registry doesn't list.** Its tests and a partial rollback rely on admitting the owner to such ids. Refusing the retired id alone is enough.

## References

- [ADR-0013](0013-self-configuration.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0028](0028-setup-step-notes.md), [ADR-0029](0029-continuous-deployment-and-rollback.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0039](0039-routines-as-vault-files.md)
- [Decision 5.27 (#382)](https://github.com/guedesdiogo/kelpie/issues/382), with the reference check; [Story 5.28 (#383)](https://github.com/guedesdiogo/kelpie/issues/383)
- Hermes Agent at [`e6899c8`](https://github.com/NousResearch/hermes-agent/tree/e6899c8090da3bd48c829893e4103ce989d3482d): [onboarding in the main agent](https://github.com/NousResearch/hermes-agent/blob/e6899c8090da3bd48c829893e4103ce989d3482d/tui_gateway/methods_onboarding.py#L283-L291), [the guard on its own config](https://github.com/NousResearch/hermes-agent/blob/e6899c8090da3bd48c829893e4103ce989d3482d/tools/file_tools_write_guards.py#L166-L173)
- ai-memory at [`11ca7c5`](https://github.com/akitaonrails/ai-memory/tree/11ca7c5b3b65e7fc216c7eae5a9aac67d38c11ea): [caller levels in the same tools](https://github.com/akitaonrails/ai-memory/blob/11ca7c5b3b65e7fc216c7eae5a9aac67d38c11ea/crates/ai-memory-mcp/src/server.rs#L3584-L3611)
- invokta at [`f1e2f04`](https://github.com/vinilana/invokta/tree/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5): [access enforced by the engine](https://github.com/vinilana/invokta/blob/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5/packages/core/src/engine.ts#L410-L446)
