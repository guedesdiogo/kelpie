# ADR-0067: Master can do from chat what the owner can do on the admin API

- Status: Accepted
- Date: 2026-10-22
- Issue: [#489](https://github.com/guedesdiogo/kelpie/issues/489)
- Decided by the owner on 2026-10-22:
  - the request: «Preciso que o kelpie master, tenha o máximo de permissões possíveis para obedecer o que eu solicitar para ele.»;
  - on confirmations: «Manter + botão no Telegram»;
  - the plan: «Aprovo os três (Recomendado)», for #489, #490 and #491. Two reviews then adjusted it, as #489's scope notes record, and the owner's answer to them is quoted there.
- Amends: [ADR-0013](0013-self-configuration.md), [ADR-0020](0020-shared-memory-engine.md) §5, [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0036](0036-agent-roles-models-and-subagents.md) §6, [ADR-0048](0048-master-configures-kelpie.md) §1, [ADR-0050](0050-master-orchestration-tools.md), [ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md) §1 and §2, and [ADR-0064](0064-outside-content-asks.md) §4

## Context

ADR-0048 gave Master the setup agent's 14 configuration tools, and ADR-0050 made them, the subagent tools and the board's task tools mandatory for Master. The admin API and the webchat's editor still reach more. Asked on Telegram what it can do, Master listed what it can't: pause or cancel background tasks, act on the VPS's sessions, deploy, and set bindings, secrets, Access and model keys.

A read of `main` at `f177fab`, recorded on #489, found these gaps:
- **The board.** Master reads no board, and can't stop, edit, move or schedule another agent's task. Its `cancel_task` ends only a task's run from inside it.
- **The owner's account.** Identities, the time zone and a bot's webhook have no tool.
- **The vault.** Held files, erasure and Dream have no tool.
- **Proposals.** Master can't read them, and only their page decides them (ADR-0061).
- **Agents' files.** SOUL.md, AGENTS.md, memories/MEMORY.md and skills change only in the webchat's editor (ADR-0058). `configure_agent` takes no `skills`, `memoryCore` or `specialty`.
- **Size.** A change whose summary passes 3,500 visible characters is refused in chat.

**Two limits of the deploy order** shape the design. Each Worker binds only the Workers deployed before it: `channel-egress`, `llm-gateway`, `context-store`, `conversation-runtime`, `ingress`, then `admin-api` ([`docs/deploy.md`](../deploy.md)).
- The identities and the time zone live in the `Directory`, in `ingress`, which binds `conversation-runtime`. So the Worker Master runs in can't reach them (`docs/admin-api.md`). For the same reason, `delete_agent` names only the owner's webchat thread.
- `admin-api`, deployed last, binds every one of them.

Two other parts of the owner's request have their own decisions: the VPS's sessions ([ADR-0069](0069-master-acts-on-vps-sessions.md)) and model keys ([ADR-0068](0068-every-secret-through-an-expiring-form.md)). The owner kept deploy, bindings and Access out, since they need a Cloudflare token at runtime (ADR-0013).

The reference check is on #489.

## Decision

### 1. Master's new tools

Each runs the same command as the admin API, as the owner, through Master (`via: agent:<Master's id>`), with the commands' own checks, except where this section says otherwise. Like the configuration tools, the new tools are owner-only, run only in the owner's direct conversation, and are never offered in a task's run (#335). They join `MASTER_TOOLS` (ADR-0050).

| Tool | Command | The yes |
|---|---|---|
| `list_tasks`, `get_task` | `listTasks`, `getTask`, on any agent's board | none: they read |
| `create_task` | in the owner's direct conversation, gains Backlog or To do, an optional start time, and any agent as its assignee, Master included | none, as today |
| `edit_task` | `editTask`: a task's start time, and its title or body only when Master created it | none |
| `move_task` | `moveTask`: between Backlog and To do | none |
| `stop_task` | `requestStop`: stops a running task, or cancels a waiting one | none; Kelpie announces it |
| `enable_identity`, `disable_identity` | `enableIdentity`, `disableIdentity`, applied on the change's page (§2) | the owner's submission there |
| `set_time_zone` | `setTimeZone`, applied on the change's page (§2) | the owner's submission there |
| `register_telegram_webhook` | `registerTelegramWebhook` | the owner's confirmation: an external account |
| `list_held_files` | `listHeldFiles` | none: it reads |
| `forget_vault_paths` | `forgetVaultPaths` | the owner's confirmation: erasure can't be undone |
| `set_dream` | `setDream` | the owner's confirmation: cost |
| `list_proposals`, `get_proposal` | `listProposals`, `getProposal` | none: they read |
| `open_proposal` | has Kelpie send the link to a pending proposal's page | the owner's act on that page, which alone decides (ADR-0061) |
| `read_agent_file` | ADR-0058's reads of SOUL.md, AGENTS.md, memories/MEMORY.md and a skill | none: it reads |
| `write_agent_file` | ADR-0058's writes of the same files | the owner's confirmation of the whole change |
| `configure_agent` | gains `skills`, `memoryCore` and `specialty` | the owner's confirmation, as today |

- **The tools that change something with no yes** are ADR-0013's smaller changes. Each says that it changes something, so ADR-0064 holds it for the owner's yes after outside content. The read tools say that they only read. `open_proposal` is held after outside content, as the other link tools are (ADR-0064 §4).
- **Master's words stay Master's.** A task's title, body and comments reach its assignee as the owner's words, unfenced, when the owner wrote them, and fenced as an agent's when an agent did. So:
  - `create_task` stays the agent path (`createTaskFor`): the task is Master's, its text reaches the assignee fenced as Master's, its news comes back to Master, and its caps hold: three a turn, 20 a day from turns no person typed, and 20 open per assignee;
  - `createTaskFor` takes Master as a creator for any agent, itself included, besides each agent's owner. This lifts ADR-0050's gate "Master owning the agents it hands tasks to" for Master;
  - in a task's run, `create_task` stays as it is today: To do, no start time, an agent Master owns;
  - `edit_task` runs `editTask` as the owner, but changes the title or the body only of a task Master created.
- **A stop Master asks for** is the owner's stop, through Master: `requestStop` records it as `via: agent:<Master's id>`. Kelpie announces it as it announces a handoff (ADR-0036 §4), naming the agent. A task in Backlog or To do isn't stopped: `move_task` sends it back to Backlog.
- **The webhook** needs a narrow `channel-egress` entrypoint that registers it and returns no secret, since `SetupForms` can't (`docs/secrets.md`). `channel-egress` deploys first, so the binding is allowed.
- **`write_agent_file`'s commit:**
  - conversation-runtime binds ADR-0058's `AgentFiles` too, but only its `files` and `save`: a skill fetched from outside still goes through the editor's review (ADR-0058 §5);
  - `AgentFiles`'s owner check then trusts the Worker the model drives, as `configure_agent`'s commands already do;
  - the commit's trailer names Master, `Kelpie-Via: agent:<Master's id>`;
  - the sanitizer runs on Master's text before the confirmation shows it, since the model wrote it;
  - once the owner confirms the whole change, it counts as the owner's edit, as a Save in the editor does (ADR-0058 §1). That confirmation is ADR-0020 §5's approval of a change to a persona, rules or skills.
- **`delete_agent` keeps its gap:** it still names only the webchat thread, since conversation-runtime can't read the Directory. The admin API's `deleteAgent` covers every thread.

### 2. Some changes are confirmed on a page

- **Which ones:**
  - a change whose summary passes 3,500 visible characters, including one ADR-0064 §4 holds after outside content, which it refuses today when it is too long;
  - a change to the identities or the time zone, which only `admin-api` can apply.
- **How:**
  - the tool stores the pending change in the Registry, typed, with the owner's actor through Master, as a proposal is stored. `admin-api` binds the Registry;
  - Kelpie sends the link to an admin API page that shows the whole change: a file before and after, as a diff;
  - the owner's submission there is the yes (ADR-0026 §1). `admin-api` then runs the command, once, within 10 minutes, for exactly the change the page shows;
  - Kelpie sends the link itself, as it sends a form's (ADR-0026 §2), and ADR-0064 holds the call after outside content, as it holds the form tools.
- **Master can't read the identities,** for the same reason. The page lists them, masked as the admin API lists them.

### 3. Kelpie's Confirm button on Telegram

ADR-0026 §4 left Telegram's inline buttons for later. They come now:
- Kelpie's confirmation notice on Telegram carries an inline Confirm button. Its callback data is the confirmation's random id, never a counter or "the oldest pending".
- A press counts only from the paired owner's account, in that chat, for a confirmation of theirs that is still open, once. It then replies with the code for them, as the webchat's button does (ADR-0026 §3).
- The typed code stays.
- ingress's handling of Telegram's callbacks is shared with the model picker of [ADR-0055](0055-composer-files-dictation-and-model.md) and with [ADR-0069](0069-master-acts-on-vps-sessions.md)'s Approve and Deny. Whichever story lands first builds it.

### 4. What stays out of Master's reach

- **The confirmations themselves.** They stay code, which Master can't turn off (ADR-0048 §1), by the owner's answer.
- **Deciding a proposal.** Only its page decides (ADR-0061). Master sends the link, and ADR-0061's rule not to urge a decision still applies.
- **Deploy, bindings, Access, custom domains and Hyperdrive.** They need a Cloudflare token at runtime (ADR-0013).
- **The bootstrap and the recovery.** They exist for when chat can't reach the owner.
- **Pausing a conversation.** It is the owner's brake on the model. A brake the model can press or lift isn't a brake.
- **Comments with the owner's authority.** Master's comments on a task stay an agent's, fenced (ADR-0036 §6). No other agent should take Master's words for the owner's.
- **Master's own specialty,** which `configureAgent` already refuses.

### 5. Amendments

- **[ADR-0013](0013-self-configuration.md):** Master reaches every owner command but those in §4, the Directory's through the page of §2.
- **[ADR-0020](0020-shared-memory-engine.md) §5:** the owner's confirmation of Master's write to a persona, rules or a skill is the approval of point 5.
- **[ADR-0026](0026-confirmation-by-owner-act.md):** the page of §2, and the Telegram button (§3).
- **[ADR-0036](0036-agent-roles-models-and-subagents.md) §6:** Master reads any board and changes it as the owner through it, but its own tasks' text and its comments stay an agent's.
- **[ADR-0048](0048-master-configures-kelpie.md) §1:** Master holds the tools in §1 besides the configuration tools.
- **[ADR-0050](0050-master-orchestration-tools.md):** `MASTER_TOOLS` gains them, and Master hands tasks to any agent, not only those it owns.
- **[ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md):**
  - §1: Master's write, once the owner confirms it, is the owner's edit too, with Master in its trailer, and the sanitizer runs on it first;
  - §2: conversation-runtime binds `AgentFiles` too, its `files` and `save` only.
- **[ADR-0064](0064-outside-content-asks.md) §4:** a held change too long for one bubble is confirmed on the page of §2, instead of not running.

## Consequences

- **The owner asks Master for anything the admin API does,** except §4. Master no longer points the owner to the admin API for a task, an identity, the time zone, a webhook, the vault, an agent's file or a long change. For a proposal it sends the page.
- **Master's prompt grows by about 17 tools.** That costs tokens on every Master turn, and gives the model more to choose from. The stories may merge the read tools into fewer, and the handoff eval (#287) is measured again.
- **A steered Master reaches more.** The same gates hold:
  - owner-only;
  - the owner's confirmation for access, cost, external accounts and erasure;
  - ADR-0064's hold after outside content;
  - no configuration in a task's run.
- **No new cost:** the tools run commands that already exist, within the Workers Paid plan. `set_dream` takes the owner's confirmation because Dream itself spends.
- **Rollback:** each story's pull request reverts on its own. The pending changes of §2 are stored add-only.
- **The stories** are sub-issues of [#19](https://github.com/guedesdiogo/kelpie/issues/19):
  - [#492](https://github.com/guedesdiogo/kelpie/issues/492), Master's board tools;
  - [#493](https://github.com/guedesdiogo/kelpie/issues/493), Master's owner tools: a bot's webhook, the vault and proposals' pages;
  - [#494](https://github.com/guedesdiogo/kelpie/issues/494), agents' files, `configure_agent`'s missing fields, and the page of §2 with the identities and the time zone;
  - [#495](https://github.com/guedesdiogo/kelpie/issues/495), Kelpie's Confirm button on Telegram.

## Alternatives considered

- **Drop the confirmations for the turns the owner types.** The owner chose to keep them, with a button on Telegram.
- **A timed "free mode" that the owner turns on,** as Hermes's `/yolo` does. The owner chose the button instead.
- **A Cloudflare token for Master.** The owner kept deploy, bindings and Access out.
- **`decide_proposal`, deciding a proposal with a confirmation in chat.** ADR-0061 keeps the decision to the proposal's page, which shows the whole change and alone decides. Master sends its link instead.
- **`create_task` and `edit_task` as the owner's commands.** The assignee would read Master's words as the owner's, unfenced.
- **conversation-runtime binding the Directory.** `ingress` binds conversation-runtime, so the two would bind each other, against the deploy order. The page of §2 reaches it through `admin-api`.
- **Master comments with the owner's authority.** A specialist would then read Master's words as the owner's, and the board would lose who said what.
- **Master pauses conversations.** The pause would no longer bind the model it stops.

## References

- [#489](https://github.com/guedesdiogo/kelpie/issues/489): the gap map and the reference check
- [ADR-0013](0013-self-configuration.md), [ADR-0020](0020-shared-memory-engine.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0048](0048-master-configures-kelpie.md), [ADR-0050](0050-master-orchestration-tools.md), [ADR-0055](0055-composer-files-dictation-and-model.md), [ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md), [ADR-0061](0061-proposals.md), [ADR-0064](0064-outside-content-asks.md)
- [`docs/deploy.md`](../deploy.md): the Workers' deploy order
- Hermes Agent at [`41dfcf2`](https://github.com/NousResearch/hermes-agent/tree/41dfcf2c1bd7146d4ad46aea08b7dd007900602e): [`cronjob_manage`](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/tools/cronjob_tools.py#L957-L964), [no tool for its approval mode](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/tools/file_tools_write_guards.py#L166-L174), [instruction files always ask](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/tools/file_tools_write_guards.py#L177-L190), [a Telegram tap resolves the oldest approval](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/plugins/platforms/telegram/adapter.py#L4761)
- ai-memory at [`e52abcb`](https://github.com/akitaonrails/ai-memory/tree/e52abcb6bf2add76d63d5729afda99165475e73e): [the agent never sets its approval mode](https://github.com/akitaonrails/ai-memory/blob/e52abcb6bf2add76d63d5729afda99165475e73e/crates/ai-memory-mcp/src/server.rs#L4202-L4207), [the `/pending` page](https://github.com/akitaonrails/ai-memory/blob/e52abcb6bf2add76d63d5729afda99165475e73e/crates/ai-memory-web/src/routes/pending.rs#L1-L7)
- invokta at [`f1e2f04`](https://github.com/vinilana/invokta/tree/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5): [access checked by the engine](https://github.com/vinilana/invokta/blob/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5/packages/core/src/engine.ts#L410-L446)
