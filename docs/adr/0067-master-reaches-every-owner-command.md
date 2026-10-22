# ADR-0067: Master can do from chat what the owner can do on the admin API

- Status: Accepted
- Date: 2026-10-22
- Issue: [#489](https://github.com/guedesdiogo/kelpie/issues/489)
- Decided by the owner on 2026-10-22:
  - the request: «Preciso que o kelpie master, tenha o máximo de permissões possíveis para obedecer o que eu solicitar para ele.»;
  - on confirmations: «Manter + botão no Telegram»;
  - the plan: «Aprovo os três (Recomendado)», for #489, #490 and #491.
- Amends: [ADR-0013](0013-self-configuration.md), [ADR-0020](0020-shared-memory-engine.md) §5, [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0036](0036-agent-roles-models-and-subagents.md) §6, [ADR-0048](0048-master-configures-kelpie.md) §1, [ADR-0050](0050-master-orchestration-tools.md) and [ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md) §1 and §2

## Context

ADR-0048 gave Master the setup agent's 14 configuration tools, and ADR-0050 made them, the subagent tools and the board's task tools mandatory for Master. The admin API and the webchat's editor still reach more. Asked on Telegram what it can do, Master listed what it can't: pause or cancel background tasks, act on the VPS's sessions, deploy, and set bindings, secrets, Access and model keys.

A read of `main` at `f177fab`, recorded on #489, found these gaps:
- **The board.** Master reads no board, and can't stop, edit, move or schedule another agent's task. Its `cancel_task` ends only a task's run from inside it.
- **The owner's account.** Identities, the time zone and a bot's webhook have no tool.
- **The vault.** Held files, erasure and Dream have no tool.
- **Proposals.** Master can't read them, and only their page decides them.
- **Agents' files.** SOUL.md, AGENTS.md, memories/MEMORY.md and skills change only in the webchat's editor (ADR-0058). `configure_agent` takes no `skills`, `memoryCore` or `specialty`.
- **Size and reach.** A change whose summary passes 3,500 visible characters is refused in chat, and `delete_agent` names only the owner's webchat thread.

Two other parts of the owner's request have their own decisions: the VPS's sessions ([ADR-0069](0069-master-acts-on-vps-sessions.md)) and model keys ([ADR-0068](0068-every-secret-through-an-expiring-form.md)). The owner kept deploy, bindings and Access out, since they need a Cloudflare token at runtime (ADR-0013).

The reference check is on #489.

## Decision

### 1. Master's new tools

Each new tool runs the same command as the admin API, as the owner, through Master (`via: agent:<Master's id>`), with the commands' own checks. Like the configuration tools, the new tools are owner-only, run only in the owner's direct conversation, and are never offered in a task's run (#335). They join `MASTER_TOOLS` (ADR-0050). The two widened tools, `create_task` and `delete_agent`, keep their own paths, as the rules below say.

| Tool | Command | The yes |
|---|---|---|
| `list_tasks`, `get_task` | `listTasks`, `getTask`, on any agent's board | none: they read |
| `create_task` | in the owner's direct conversation, gains Backlog or To do, an optional start time, and any agent as its assignee, Master included | none, as today |
| `edit_task`, `move_task` | `editTask`, `moveTask` | none |
| `stop_task` | `requestStop`: stops a running task, or cancels a waiting one | none; Kelpie announces it |
| `list_identities` | `listIdentities` | none: it reads |
| `enable_identity`, `disable_identity` | `enableIdentity`, `disableIdentity` | the owner's confirmation: access |
| `set_time_zone` | `setTimeZone` | none |
| `register_telegram_webhook` | `registerTelegramWebhook` | the owner's confirmation: an external account |
| `list_held_files` | `listHeldFiles` | none: it reads |
| `forget_vault_paths` | `forgetVaultPaths` | the owner's confirmation: erasure can't be undone |
| `set_dream` | `setDream` | the owner's confirmation: cost |
| `list_proposals`, `get_proposal` | `listProposals`, `getProposal` | none: they read |
| `open_proposal` | has Kelpie send the link to the proposal's page (ADR-0061) | the owner's act on the page, which alone decides |
| `read_agent_file` | ADR-0058's reads of SOUL.md, AGENTS.md, memories/MEMORY.md and a skill | none: it reads |
| `write_agent_file` | ADR-0058's writes of the same files, through its `AgentFiles` | the owner's confirmation of the whole change |
| `configure_agent` | gains `skills`, `memoryCore` and `specialty` | the owner's confirmation, as today |
| `delete_agent` | deletes every thread, as the admin API does | the owner's confirmation, as today |

- **The tools that change something with no yes** are ADR-0013's smaller changes. Each says that it changes something, so ADR-0064 holds it for the owner's yes after outside content. The read tools say that they only read.
- **Master's words stay Master's.** A task's title, body and comments reach its assignee as the owner's words, unfenced, when the owner wrote them, and fenced as an agent's when an agent did. So:
  - `create_task` stays the agent path (`createTaskFor`): the task is Master's, its text reaches the assignee fenced as Master's, its news comes back to Master, and its caps hold: three a turn, 20 a day from turns no person typed, and 20 open per assignee;
  - `edit_task` changes the title or the body only of a task Master created. On any other task it changes only the start time;
  - in a task's run, `create_task` stays as it is today: To do, no start time, an agent Master owns.
- **A stop Master asks for** is the owner's stop, through Master: `requestStop` records it as `via: agent:<Master's id>`. Kelpie announces it as it announces a handoff (ADR-0036 §4), naming the agent. A task in Backlog or To do isn't stopped: `move_task` sends it back to Backlog.
- **Two bindings conversation-runtime lacks** come with their stories: the Directory, for the identity and time-zone commands, and a narrow `channel-egress` entrypoint that registers a bot's webhook and returns no secret, since `SetupForms` can't (`docs/secrets.md`).
- **`write_agent_file`'s commit:**
  - conversation-runtime binds ADR-0058's `AgentFiles` too, with the same three methods;
  - the commit's trailer names Master, `Kelpie-Via: agent:<Master's id>`;
  - the sanitizer runs on Master's text before the confirmation shows it, since the model wrote it;
  - once the owner confirms the whole change, it counts as the owner's edit, as a Save in the editor does (ADR-0058 §1). That confirmation is ADR-0020 §5's approval of a change to a persona, rules or skills.
- **`delete_agent` deletes every thread** once conversation-runtime binds the Directory, as the admin API's does.

### 2. A long change is confirmed on a page

- A confirmation whose summary passes 3,500 visible characters no longer sends the owner to the admin API. That includes a change ADR-0064 §4 holds after outside content, which it refuses today when it is too long.
- Kelpie sends a link to an admin API page that shows the whole change. For a file, that is the file before and after, as a diff.
- The owner's submission on the page is the yes (ADR-0026 §1). It counts once, within the confirmation's 10 minutes, for exactly the change the page shows.
- Kelpie sends the link itself, as it sends a form's (ADR-0026 §2).

### 3. Kelpie's Confirm button on Telegram

ADR-0026 §4 left Telegram's inline buttons for later. They come now:
- Kelpie's confirmation notice on Telegram carries an inline Confirm button. Its callback data is the confirmation's random id, never a counter or "the oldest pending".
- A press counts only from the paired owner's account, in that chat, for a confirmation of theirs that is still open, once. It then replies with the code for them, as the webchat's button does (ADR-0026 §3).
- The typed code stays.
- ingress's handling of Telegram's callbacks is shared with the model picker of [ADR-0055](0055-composer-files-dictation-and-model.md). Whichever story lands first builds it.

### 4. What stays out of Master's reach

- **The confirmations themselves.** They stay code, which Master can't turn off (ADR-0048 §1), by the owner's answer.
- **Deploy, bindings, Access, custom domains and Hyperdrive.** They need a Cloudflare token at runtime (ADR-0013).
- **The bootstrap and the recovery.** They exist for when chat can't reach the owner.
- **Pausing a conversation.** It is the owner's brake on the model. A brake the model can press or lift isn't a brake.
- **Comments with the owner's authority.** Master's comments on a task stay an agent's, fenced (ADR-0036 §6). No other agent should take Master's words for the owner's.
- **Master's own specialty,** which `configureAgent` already refuses.

### 5. Amendments

- **[ADR-0013](0013-self-configuration.md):** Master reaches every owner command but those in §4.
- **[ADR-0020](0020-shared-memory-engine.md) §5:** the owner's confirmation of Master's write to a persona, rules or a skill is the approval of point 5.
- **[ADR-0026](0026-confirmation-by-owner-act.md):** the page for a long change (§2), and the Telegram button (§3).
- **[ADR-0036](0036-agent-roles-models-and-subagents.md) §6:** Master reads and changes any board, as the owner through it. Its comments stay an agent's.
- **[ADR-0048](0048-master-configures-kelpie.md) §1:** Master holds the tools in §1 besides the configuration tools.
- **[ADR-0050](0050-master-orchestration-tools.md):** `MASTER_TOOLS` gains them.
- **[ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md):**
  - §1: Master's write, once the owner confirms it, is the owner's edit too, with Master in its trailer, and the sanitizer runs on it first;
  - §2: `AgentFiles` is bound by conversation-runtime too.

## Consequences

- **The owner asks Master for anything the admin API does,** except §4. Master no longer points the owner to the admin API for a task, an identity, the time zone, a webhook, the vault, a proposal, an agent's file or a long change.
- **Master's prompt grows by about 17 tools.** That costs tokens on every Master turn, and gives the model more to choose from. The stories may merge the read tools into fewer, and the handoff eval (#287) is measured again.
- **A steered Master reaches more.** The same gates hold:
  - owner-only;
  - the owner's confirmation for access, cost, external accounts and erasure;
  - ADR-0064's hold after outside content;
  - no configuration in a task's run.
- **No new cost:** the tools run commands that already exist, within the Workers Paid plan. `set_dream` takes the owner's confirmation because Dream itself spends.
- **Rollback:** each story's pull request reverts on its own. A long change's page stores its pending change add-only.
- **The stories** are sub-issues of [#19](https://github.com/guedesdiogo/kelpie/issues/19):
  - [#492](https://github.com/guedesdiogo/kelpie/issues/492), Master's board tools;
  - [#493](https://github.com/guedesdiogo/kelpie/issues/493), Master's owner tools: identities, the time zone, the webhook, the vault and proposals' pages;
  - [#494](https://github.com/guedesdiogo/kelpie/issues/494), agents' files, `configure_agent`'s missing fields, the full deletion, and the page for long changes;
  - [#495](https://github.com/guedesdiogo/kelpie/issues/495), Kelpie's Confirm button on Telegram.

## Alternatives considered

- **Drop the confirmations for the turns the owner types.** The owner chose to keep them, with a button on Telegram.
- **A timed "free mode" that the owner turns on,** as Hermes's `/yolo` does. The owner chose the button instead.
- **A Cloudflare token for Master.** The owner kept deploy, bindings and Access out.
- **`decide_proposal`, deciding a proposal with a confirmation in chat.** ADR-0061 keeps the decision to the proposal's page, which shows the whole change and alone decides. Master sends its link instead.
- **`create_task` and `edit_task` as the owner's commands.** The assignee would read Master's words as the owner's, unfenced.
- **Master comments with the owner's authority.** A specialist would then read Master's words as the owner's, and the board would lose who said what.
- **Master pauses conversations.** The pause would no longer bind the model it stops.

## References

- [#489](https://github.com/guedesdiogo/kelpie/issues/489): the gap map and the reference check
- [ADR-0013](0013-self-configuration.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0048](0048-master-configures-kelpie.md), [ADR-0050](0050-master-orchestration-tools.md), [ADR-0055](0055-composer-files-dictation-and-model.md), [ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md), [ADR-0064](0064-outside-content-asks.md)
- Hermes Agent at [`41dfcf2`](https://github.com/NousResearch/hermes-agent/tree/41dfcf2c1bd7146d4ad46aea08b7dd007900602e): [`cronjob_manage`](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/tools/cronjob_tools.py#L957-L964), [no tool for its approval mode](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/tools/file_tools_write_guards.py#L166-L174), [instruction files always ask](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/tools/file_tools_write_guards.py#L177-L190), [a Telegram tap resolves the oldest approval](https://github.com/NousResearch/hermes-agent/blob/41dfcf2c1bd7146d4ad46aea08b7dd007900602e/plugins/platforms/telegram/adapter.py#L4761)
- ai-memory at [`e52abcb`](https://github.com/akitaonrails/ai-memory/tree/e52abcb6bf2add76d63d5729afda99165475e73e): [the agent never sets its approval mode](https://github.com/akitaonrails/ai-memory/blob/e52abcb6bf2add76d63d5729afda99165475e73e/crates/ai-memory-mcp/src/server.rs#L4202-L4207), [the `/pending` page](https://github.com/akitaonrails/ai-memory/blob/e52abcb6bf2add76d63d5729afda99165475e73e/crates/ai-memory-web/src/routes/pending.rs#L1-L7)
- invokta at [`f1e2f04`](https://github.com/vinilana/invokta/tree/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5): [access checked by the engine](https://github.com/vinilana/invokta/blob/f1e2f04f98c967ab4bb73bd02c3fa581f04ce0e5/packages/core/src/engine.ts#L410-L446)
