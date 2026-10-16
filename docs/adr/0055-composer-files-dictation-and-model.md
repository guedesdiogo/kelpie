# ADR-0055: The composer attaches files and dictates text, and the owner's own pick of an agent's model is the yes

- Status: Accepted
- Date: 2026-10-16
- Issue: [#406](https://github.com/guedesdiogo/kelpie/issues/406)
- Decided by the owner on 2026-10-16; his answers are quoted on #406

## Context

On 2026-10-16, reviewing #378's composer, the owner asked for three things:
- a microphone, to send audio;
- a "+", to add other items to the conversation;
- a way to choose the LLM, the model and the effort of the agent's chat.

He also asked what competitors offer: «verifique quais opções nossos concorrentes possuem na área do chat para enviar (…) precisamos validar o que faz sentido no nosso contexto».

**Today** (`main` at `6061004`):
- **The composer** is one row: the text, Pause and Send (#378, decision 4; design system §5.20).
- **Files.** #157 (Story 4.17) plans to turn a Telegram photo, voice note or document into a pointer note with derived text. The bytes go to R2 (ADR-0032), and Workers AI's Whisper transcribes audio. #157 leaves webchat uploads to a later story.
- **The model.**
  - Each agent has a `conversation`-area trio: provider, tier and effort (ADR-0036 §2).
  - The owner changes it by asking Master, and the change waits for Kelpie's confirmation (ADR-0026, ADR-0048 §2). On Telegram that confirmation is the typed code.
  - The Telegram webhook accepts `message` updates only, and no Kelpie message carries inline buttons.
- **Cost.** CLAUDE.md keeps a feature that bills only past a free tier on, behind #269's alert at 90% of the tier. That alert isn't built yet.

The research is #406's first comment. It covers the design system's §8, the products, and the reference projects' source:
- **Every AI chat it read** puts dictation behind the composer's microphone; messaging apps send voice messages instead.
- **Claude.ai** puts the model and effort picker next to Send. A change applies from the next reply.
- **Claude Code** keeps `max` for the current session only.
- **Hermes Agent** had a composer pick that stuck in the browser and silently overrode the default, and a user was billed for a paid model ([hermes-agent#62055](https://github.com/NousResearch/hermes-agent/issues/62055)).
- **Workers AI's `whisper-large-v3-turbo`** costs $0.0005 a minute after the 10,000 free neurons a day, about 214 minutes. The vault's embeddings share that allocation.

- **Hermes's Telegram `/model` picker** sends inline buttons, edits its message in place, and checks the option on the server.
  - Its callbacks had no auth check until [hermes-agent#123261](https://github.com/NousResearch/hermes-agent/issues/123261).
  - Its state has no expiry, and the message id is never checked.
  - Its approval buttons resolve the oldest pending approval, not the one tapped.

The issue put ten questions to the owner. Five of his answers change a decision. Where this ADR repeats #406's proposal on a point no question asked about, such as the 20 MB limit, `@` for notes or dictation's limits, it is the proposal the owner answered on, and the stories may refine it.

## Decision

### 1. The "+" attaches files and notes from memory

- **A file attached in the webchat is a file that arrives on a channel,** so [ADR-0032](0032-file-bytes-in-r2.md) applies as it stands:
  - the bytes go to R2 under their SHA-256;
  - a pointer note under `files/` holds the derived text;
  - erasure and export cover both stores.

  The pipeline is #157's, and the limit is Telegram's 20 MB.
- **The composer says that a file becomes memory,** beside the attached files, since a chat doesn't make that obvious.
- **A note from memory** attaches a vault note by its path, from the "+" or by typing `@`.
  - It stores nothing new.
  - The path resolves on the server, within the agent's read scopes.
  - Its text enters the turn as any note the agent reads does, so a long note costs tokens like one.

### 2. Dictation keeps only the text

- **The microphone dictates into the field,** and never sends by itself.
- **Only Cloudflare hears the voice.**
  - The page records a clip, and llm-gateway transcribes it with Workers AI's `whisper-large-v3-turbo`, one clip at a time. The text lands when the owner stops, not while he speaks.
  - Transcription sits behind an interface and a config value in llm-gateway, with Whisper turbo as its first adapter (CLAUDE.md's pluggable connectors).
  - Streaming speech-to-text, the browser's Web Speech API and third-party speech-to-text keys are out. Each would need a decision of its own.
- **The audio is discarded once transcribed.**
  - The page holds the clip in memory for one retry. It drops the clip once the text lands, on a cancel, or after the retry fails.
  - Nothing of it reaches R2, the vault, a log or the conversation's history.
  - The transcription calls the Workers AI binding directly, without AI Gateway, as Clef and the embeddings do, so no gateway log holds it. An error logs no body.
  - ADR-0032 doesn't apply, because dictation is typing, not a file arriving.
- **Telegram differs on purpose.** A voice note there is a message, so it is a file that #157 keeps under ADR-0032.

### 3. Cost

- **Dictation and uploads ship on,** before #269's alert exists, as CLAUDE.md says of a feature that bills only past a free tier.
  - Each records what it uses: minutes transcribed and bytes stored.
  - #269 counts them when it lands.
- **The model chip and Telegram's picker take no hold and no confirmation,** even to raise the tier to `frontier` or the effort to `max`. The pick is the owner's explicit request for that spend.
- **A pick applies to every turn of the agent:** its conversations, tasks and routines. The notice of §5 says so.

### 4. The model chip sets the agent's trio

- **It changes the agent, not the turn.**
  - The chip shows and changes the agent's own `conversation`-area trio, the first level of ADR-0036 §2.
  - The change is made on the server, and applies from the next reply, wherever the agent answers, Telegram included.
  - The `memory` area stays with Master.
- **It offers:**
  - the chat providers that have a key, never a qualifier's or a gateway-only key;
  - the tiers `cheap`, `medium` and `frontier`, with the default marked;
  - the efforts the resolved model supports, with the clamp stated (ADR-0036 §2).
- **Each tier shows, read-only, the model it runs on,** as `MODEL_ROUTES` resolves it for the chosen provider. Hovering a reply shows which model answered it. Nobody types a model id, and the route fallbacks don't change.
- **It offers only what the agent may run on.** A subagent never exceeds its creator (ADR-0036 §5).
- **An agent on `auto`** (ADR-0041) shows `auto` in the chip.
  - Picking a fixed tier takes the agent off `auto`, and setting `auto` again goes through Master.
  - Whether the chip offers `auto` waits until #320 reports its pick's agreement.
- **`max` lasts for one reply.**
  - Picking `max` sets it for the next turn that the owner's message starts in the conversation it was picked in. That covers every tool round, and a continuation past the bound (ADR-0040 §4), as `auto`'s tier is kept.
  - A task, a routine or a subagent's return in that conversation doesn't take it. Only the conversation's own agent can get it.
  - It is held with the conversation on the server, as ADR-0041 §3 holds a turn's pick. It is not stored in the agent's settings and is not a trio change.
  - The effort then returns to the agent's own, and the chip says "next reply only" until it does.
  - Keeping `max` on an agent is a trio change through Master, with the confirmation.
  - Under `auto`, the one-reply `max` applies to whichever tier the qualifier picks, since `auto` doesn't touch the effort (ADR-0041 §6).
  - A subagent created in that turn is capped at its creator's own effort, not at `max`.

### 5. The owner's pick is the yes

**In the webchat:**
- **A pick on the chip is the owner's act on a Kelpie page** (ADR-0026 §1). It applies with no confirmation step.
- **The route takes only a `PUT` with a JSON body.**
  - It refuses a request without `Origin`, from another origin, or without the owner's Access login.
  - The Directory resolves the owner, and admits this login to the agent.
- **A pick sets one field:** the provider, the tier or the effort. So a stale tab can't revert the others.
- **It reaches the agent through #379's `AgentEditor` entrypoint.**
  - The entrypoint gains one method, which takes the agent, the field and its value, and builds the setting itself.
  - Ingress still binds nothing else, and the command checks again that the actor is the owner.
- **The model never touches the chip.**
  - The chip is the page's own control.
  - The page's content security policy runs only its own script, and model output reaches the page only as text.

**On Telegram:**
- **Master's `pick_model` tool has Kelpie send a model picker.**
  - It takes an agent's id and nothing else: no option, and no text of the model's.
  - It is a configuration tool under ADR-0048 §1's gates: owner-only, it follows the Master role, and it never runs in a task's run.
  - It runs only in a turn the owner's message started, and only in a private chat with the owner's paired account.
  - In the webchat it sends nothing, and points to the chip.
  - A chat has one open picker. A new one closes the one before.
- **The picker is a notice of Kelpie's own** (ADR-0026 §2).
  - It names the agent by its id, and shows its current trio.
  - Its inline buttons pick the provider, the tier with its model, and the effort.
  - In a picker for Master itself, `max` lasts one reply, as on the chip, and the notice says so.
  - A picker for another agent doesn't offer `max`.
- **A tap applies at once, and sets one field.**
  - The notice is edited in place to show the new trio.
  - The tap goes through the same `AgentEditor` method as the chip, so ingress gains no other write path.
- **A tap counts only when** every one of these holds:
  - the webhook's secret matches, as for messages;
  - the chat is private;
  - `callback_query.from.id` is the owner's paired account, by the Directory. Neither the chat's id nor the message's sender counts;
  - it is on the picker's own notice, in that chat;
  - the picker is open: 10 minutes from when it was sent, and taps don't extend that;
  - the option is still one the picker offers, checked again at the tap: the agent exists, and a subagent stays within its creator;
  - its `callback_query.id` hasn't been seen before, so a redelivered tap can't undo a newer pick.
- **How the buttons stay out of the model's reach:**
  - each button's callback data carries the picker's random id, of at least 64 bits, and the option's index, within Telegram's 64 bytes;
  - the options stay on the server, and the data never carries a counter or "the latest picker" (ADR-0026 §4);
  - text that the model or a tool writes can't carry buttons. Only Kelpie's notices do;
  - the model learns only that the picker was sent, and then what the owner picked.
- **Once the picker expires,** Kelpie removes its buttons. A late tap is answered as expired, and changes nothing.
- **The Telegram webhook accepts `callback_query` updates too,** and still refuses every other new type. A bot already connected has its webhook set again, or its taps never arrive.

**On both:**
- **Every pick is audited** as configuration changes are, with these fields:
  - the owner as the actor;
  - the channel and the agent;
  - the trio before and after;
  - on Telegram, the picker's id.
- **Kelpie posts a notice in the conversation,** in the conversation's language (ADR-0027). It names the new trio, its provider included, and says that it applies from the next reply to every turn of the agent.
- **The agent's identity section** states the new trio from its next turn.

**What doesn't change:**
- Master's `configure_agent` keeps its confirmation, and so does keeping `max` on an agent.
- Telegram's other confirmations keep the typed code.
- On Telegram, Continue (ADR-0040) and Deny (ADR-0044) stay replies in words. The picker is the only Kelpie notice with buttons.
- The chip and the picker change nothing but the `conversation`-area trio.

### 6. The composer and the design system

- **The composer is no longer one row of text, Pause and Send.** This replaces #378's decision 4.
  - The "+" sits to the left of the field.
  - The microphone is its own button, so Send keeps its empty state (§5.20).
  - The chip sits next to Send. On a phone it moves into the header.
- **Each lands in §5 with its story's pull request** ([ADR-0043](0043-design-system.md)).
- **Dictation starts with a lab page of the recording's motion,** which the owner approves before it is built.

### 7. What stays off

Each of these needs the owner's approval and a decision of its own:
- streaming speech-to-text;
- live voice mode;
- reading replies aloud;
- third-party speech-to-text keys;
- the Web Speech API;
- image generation, deep research and connector toggles;
- fan-out across models.

### 8. Amendments

- **[ADR-0026](0026-confirmation-by-owner-act.md):**
  - §1: a pick on the webchat's model chip, and a tap on Kelpie's model picker on Telegram, are the owner's yes to one field of an agent's `conversation`-area trio;
  - §4: inline buttons reach Telegram for the model picker only. Their callback data carries the picker's random id, and every confirmation keeps the typed code.
- **[ADR-0036](0036-agent-roles-models-and-subagents.md),** as ADR-0048 §2 left it:
  - §2: the chip shows, read-only, the model each tier runs on, and a one-reply `max` sets the effort for one turn only;
  - §3: the owner changes an agent's `conversation`-area provider, tier or effort directly, with the chip or the picker, and that pick is the yes. Keeping `max`, and every other change, still wait for the confirmation;
  - §5: a subagent created in a one-reply `max` turn is capped at its creator's own effort;
  - §6 rule 5: a one-reply `max` is not a trio change.
- **[ADR-0040](0040-continue-at-the-tool-bound.md) §4:** a continuation also keeps the earlier turn's one-reply `max`.
- **[ADR-0048](0048-master-configures-kelpie.md) §1:** Master gains `pick_model`, which has Kelpie send the model picker. On Telegram, a change of an agent's `conversation`-area provider, tier or effort through the picker is the owner's tap. `configure_agent` and keeping `max` keep the typed code.

## Consequences

- **Three stories follow under Epic 5,** each planned on the board:
  1. the "+", with a photo or file and a note from memory, after #157;
  2. dictation, starting with its lab page;
  3. the model chip and Telegram's picker, with #379's `AgentEditor`.
- **Tests cover:**
  - the chip's refusals: a `GET`, no `Origin`, another origin, no Access, not the owner, an agent not admitted, an option not offered, a field outside the trio;
  - the picker's refusals: a tap from another account, from a group, after expiry, on another notice, for an option no longer offered, or with a `callback_query.id` already seen;
  - `pick_model` refused outside a turn the owner's message started;
  - `max` taken only by the owner's next turn, and returning after it;
  - that dictated audio is stored nowhere, AI Gateway's logs included.
- **The owner accepted #157's privacy risk for webchat files** (answer 4).
  - The derived text of a photo of an ID lands in the vault's git history.
  - Removing it takes a history rewrite (`docs/context-store.md`).
- **Spend can rise with one tap.** The owner chose no hold. The notice in the conversation and #269's report keep it visible.
- **Switching tier or provider has the costs ADR-0041 lists.**
  - The first turn on the new model pays a full cache write.
  - The new model may ignore the earlier turns' reasoning.
- **Text the agent reads can steer a pick.**
  - A note, or a file's derived text, can lead Master to open a picker, or nudge the owner toward a tap.
  - The picker itself changes nothing, and with no hold, the owner's tap is the only guard.
- **A pick lives on the server.** The chip, the notice and the identity section always show it, so it is never a hidden override in the browser, as Hermes's was.
- **A tap on Telegram rests on the paired account's security,** as the typed code does (ADR-0048 §1). It needs no code.
- **Whisper on Workers AI publishes no byte limit and no list of formats.** The dictation story tests WebM, Ogg and MP4 before its plan settles.

## Alternatives considered

- **§5.4's hold to raise the tier or the effort.** It was recommended. The owner chose one tap.
- **A per-turn or per-session override.** It would need to coexist with `auto`. Hermes's sticky browser pick billed a user.
- **Exact model ids.** That would amend ADR-0036, and an agent pinned to one model would lose the tier's fallbacks.
- **A chip that opens a confirmation card.** That makes two acts for one change.
- **Confirm and Deny inline buttons for every Telegram confirmation.** The owner chose buttons that pick the model.
- **A `/model` command on Telegram.** The owner chose to go through Master.
- **Keeping dictated audio in R2,** as Telegram's voice notes. Dictation is typing, and the owner chose to discard it.
- **Deepgram's streaming, or the Web Speech API.** The first costs 10 to 18 times Whisper's price. The second sends the audio to Google or Apple.
- **Waiting for #269 before dictation and uploads.** The worst case costs cents, and CLAUDE.md keeps such features on.

## References

- [Decision 5.30 (#406)](https://github.com/guedesdiogo/kelpie/issues/406), with the research and the owner's answers
- [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0027](0027-fixed-texts-in-three-languages.md), [ADR-0032](0032-file-bytes-in-r2.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0040](0040-continue-at-the-tool-bound.md), [ADR-0041](0041-auto-tier-by-qualifier.md), [ADR-0043](0043-design-system.md), [ADR-0048](0048-master-configures-kelpie.md)
- [#157](https://github.com/guedesdiogo/kelpie/issues/157) (files become memory), [#269](https://github.com/guedesdiogo/kelpie/issues/269) (cost reports), [#320](https://github.com/guedesdiogo/kelpie/issues/320) (the auto tier), [#378](https://github.com/guedesdiogo/kelpie/issues/378) (the webchat's redesign), [#379](https://github.com/guedesdiogo/kelpie/issues/379) (the agent's editor)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), read on 2026-10-16
- [Claude Code's model configuration](https://code.claude.com/docs/en/model-config); [Claude.ai's model and effort settings](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-extended-thinking-settings)
- Hermes Agent at [`219c6d2`](https://github.com/NousResearch/hermes-agent/tree/219c6d2ac1cbecaea84c822f292c1e325dee06a0): [the composer's voice hook](https://github.com/NousResearch/hermes-agent/blob/219c6d2ac1cbecaea84c822f292c1e325dee06a0/apps/desktop/src/app/chat/composer/hooks/use-composer-voice.ts#L55-L59), [the bots' model picker](https://github.com/NousResearch/hermes-agent/blob/219c6d2ac1cbecaea84c822f292c1e325dee06a0/apps/desktop/src/plugins/hermes-bots/model-picker.tsx#L1-L8), [Telegram's inline pickers](https://github.com/NousResearch/hermes-agent/blob/219c6d2ac1cbecaea84c822f292c1e325dee06a0/plugins/platforms/telegram/adapter.py#L4181-L4337), [the `/model` picker's state](https://github.com/NousResearch/hermes-agent/blob/219c6d2ac1cbecaea84c822f292c1e325dee06a0/plugins/platforms/telegram/adapter.py#L4294-L4312), [its callback check](https://github.com/NousResearch/hermes-agent/blob/219c6d2ac1cbecaea84c822f292c1e325dee06a0/plugins/platforms/telegram/adapter.py#L4673-L4704)
