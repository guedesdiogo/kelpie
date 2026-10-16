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

**Today** (`main` at `f56494e`):
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

The issue put ten questions to the owner. Five of his answers change a decision.

## Decision

### 1. The "+" attaches files and notes from memory

- **A file attached in the webchat is a file that arrives on a channel,** so [ADR-0032](0032-file-bytes-in-r2.md) applies as it stands:
  - the bytes go to R2 under their SHA-256;
  - a pointer note under `files/` holds the derived text;
  - erasure and export cover both stores.

  The pipeline is #157's, and the limit is Telegram's 20 MB.
- **The composer says that a file becomes memory,** beside the attached files, since a chat doesn't make that obvious.
- **A note from memory** attaches a vault note by its path, from the "+" or by typing `@`. It sends nothing new and costs nothing.

### 2. Dictation keeps only the text

- **The microphone dictates into the field,** and never sends by itself.
- **Only Cloudflare hears the voice.**
  - The page records a clip, and llm-gateway transcribes it with Workers AI's `whisper-large-v3-turbo`.
  - Streaming speech-to-text, the browser's Web Speech API and third-party speech-to-text keys are out. Each would need a decision of its own.
- **The audio is discarded once transcribed.**
  - The page holds the clip in memory for one retry. It drops the clip once the text lands, on a cancel, or after the retry fails.
  - Nothing of it reaches R2, the vault, a log or the conversation's history.
  - ADR-0032 doesn't apply, because dictation is typing, not a file arriving.
- **Telegram differs on purpose.** A voice note there is a message, so it is a file that #157 keeps under ADR-0032.

### 3. Cost

- **Dictation and uploads ship on,** before #269's alert exists, as CLAUDE.md says of a feature that bills only past a free tier.
  - Each records what it uses: minutes transcribed and bytes stored.
  - #269 counts them when it lands.
- **The model chip takes no hold and no confirmation,** even to raise the tier to `frontier` or the effort to `max`. The pick is the owner's explicit request for that spend.

### 4. The model chip sets the agent's trio

- **It changes the agent, not the turn.**
  - The chip shows and changes the agent's own `conversation`-area trio, the first level of ADR-0036 §2.
  - The change is made on the server, and applies from the next reply, wherever the agent answers, Telegram included.
  - The `memory` area stays with Master.
- **It offers:**
  - the providers that have a key;
  - the tiers `cheap`, `medium` and `frontier`, with the default marked;
  - the efforts the resolved model supports, with the clamp stated (ADR-0036 §2).
- **Each tier shows, read-only, the model it runs on,** as `MODEL_ROUTES` resolves it for the chosen provider. Hovering a reply shows which model answered it. Nobody types a model id, and the route fallbacks don't change.
- **It offers only what the agent may run on.** A subagent never exceeds its creator (ADR-0036 §5).
- **An agent on `auto`** (ADR-0041) shows `auto` in the chip. Whether the chip offers `auto` waits until #320 reports its pick's agreement.
- **`max` lasts for one reply.**
  - Picking `max` sets it for the next turn of the conversation it was picked in: every tool round, and a continuation past the bound (ADR-0040).
  - The effort then returns to the agent's own, and the chip says "next reply only" until it does.
  - It is not stored in the agent's settings and is not a trio change.
  - Keeping `max` on an agent is a trio change through Master, with the confirmation.
  - Under `auto`, the one-reply `max` applies to whichever tier the qualifier picks, since `auto` doesn't touch the effort (ADR-0041 §6).
  - A subagent created in that turn is capped at its creator's own effort, not at `max`.

### 5. The owner's pick is the yes

- **In the webchat, a pick on the chip is the owner's act on a Kelpie page** (ADR-0026 §1).
  - The request carries the owner's Access login and comes from the same origin.
  - The Directory resolves the owner, and admits this login to the agent.
  - It reaches the agent through #379's `AgentEditor` entrypoint, which gains one method for the `conversation`-area trio. Ingress still binds nothing else.
  - It applies with no confirmation notice.
- **On Telegram, the owner asks Master, and Kelpie sends a model picker.**
  - Master's tool has Kelpie send the picker, a notice of its own (ADR-0026 §2). The picker names the agent by its id, shows its current trio, and carries inline buttons for the provider, the tier with its model, and the effort.
  - A tap applies at once, and the notice updates in place to show the new trio.
  - A picker for an agent other than the conversation's own doesn't offer `max`. Keeping `max` on an agent stays a change through Master, with the confirmation.
- **A tap counts only when** every one of these holds:
  - it comes from the owner's paired Telegram account;
  - it is on Kelpie's picker notice, in that chat;
  - the picker is still open, for 10 minutes, as a confirmation;
  - it names an option that the picker offered.
- **How the buttons stay out of the model's reach.**
  - Each button's callback data carries the picker's id and the option, never a counter or "the latest picker" (ADR-0026 §4).
  - Text that the model or a tool writes can't carry buttons, and only Kelpie's notices do.
  - The model learns only that the picker was sent, and then what the owner picked.
  - The Telegram webhook also accepts `callback_query` updates.
- **Every pick is audited** as the owner's, through the webchat or Telegram.
  - Kelpie posts a notice in the conversation with the new trio and when it applies, in the conversation's language (ADR-0027).
  - The agent's identity section states the new trio from its next turn.
- **What doesn't change:**
  - Master's `configure_agent` keeps its confirmation.
  - Telegram's other confirmations keep the typed code.
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
  - §1: a pick on the webchat's model chip, and a tap on Kelpie's model picker on Telegram, are the owner's yes to an agent's `conversation`-area trio;
  - §4: inline buttons reach Telegram for the model picker. Their callback data carries the picker's id, and the typed code stays for every confirmation.
- **[ADR-0036](0036-agent-roles-models-and-subagents.md),** as ADR-0048 §2 left it:
  - §2: the chip shows, read-only, the model each tier runs on, and a one-reply `max` sets the effort for one turn only;
  - §3: the owner changes an agent's `conversation`-area trio directly, with the chip or the picker, and that pick is the yes;
  - §5: a subagent created in a one-reply `max` turn is capped at its creator's own effort;
  - §6 rule 5: a one-reply `max` is not a trio change.
- **[ADR-0048](0048-master-configures-kelpie.md) §1:** Master gains a tool that has Kelpie send the model picker. On Telegram, a model change is the owner's tap, not the typed code.

## Consequences

- **Three stories follow under Epic 5,** each planned on the board:
  1. the "+", with a photo or file and a note from memory, after #157;
  2. dictation, starting with its lab page;
  3. the model chip and Telegram's picker, with #379's `AgentEditor`.
- **Tests cover:**
  - the chip's refusals: no Access, another origin, not the owner, an agent not admitted, an option not offered;
  - the picker's refusals: a tap from another account, after expiry, on another notice, for an option not offered, or replayed;
  - `max` returning after one reply;
  - that dictated audio is stored nowhere.
- **Spend can rise with one tap.** The owner chose no hold. The notice in the conversation and #269's report keep it visible.
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
- Hermes Agent at [`219c6d2`](https://github.com/NousResearch/hermes-agent/tree/219c6d2ac1cbecaea84c822f292c1e325dee06a0): [the composer's voice hook](https://github.com/NousResearch/hermes-agent/blob/219c6d2ac1cbecaea84c822f292c1e325dee06a0/apps/desktop/src/app/chat/composer/hooks/use-composer-voice.ts#L55-L59), [the bots' model picker](https://github.com/NousResearch/hermes-agent/blob/219c6d2ac1cbecaea84c822f292c1e325dee06a0/apps/desktop/src/plugins/hermes-bots/model-picker.tsx#L1-L8)
