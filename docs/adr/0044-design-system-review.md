# ADR-0044: The owner can deny one action without stopping its agent, and the design system adds the patterns of its first review

- Status: Accepted
- Date: 2026-10-15
- Issue: [#358](https://github.com/guedesdiogo/kelpie/issues/358)
- Decided by the owner on 2026-10-15, on the design-system review's five decisions: «Aprovo as cinco decisões como você recomendou»
- Amends: [ADR-0026](0026-confirmation-by-owner-act.md), a confirmation's notice also carries a Deny button (§1)

## Context

**ADR-0043 made a rule: what the design system doesn't define starts from award-winning work.** The owner then asked for a review of the system itself in that light. Three research passes covered:
- **award-winning apps:** the Apple Design Awards 2024 to 2026, and the Red Dot and iF 2026 interface categories;
- **award-winning AI products:** the Webby Awards 2026, the first with AI categories, and Fast Company's Innovation by Design 2026;
- **the patterns the system doesn't cover yet,** read from teams known for interaction craft.

The review proposed 21 changes, showed seven of them live, and asked the owner five questions. He approved all five as recommended.

**One answer changes a binding decision.** Under ADR-0026, a confirmation's notice carries only a Confirm button. A confirmation the owner doesn't want simply waits out its 10 minutes, and there is no way to say no.

Claude Code, the Webby 2026 winner for AI features, separates two things:
- denying one call, after which the agent carries on;
- stopping the agent.

Kelpie already has the second: the pause (#134) settles the running turn at once and holds the answer until the owner's next message (ADR-0024, ADR-0025).

## Decision

### 1. A confirmation can be denied (amends ADR-0026)

- **A Deny button sits beside Confirm.** It is bound to the same confirmation's id, under ADR-0026's rules:
  - only a press from the requester's socket counts;
  - only for a confirmation of theirs that is still open;
  - only on Kelpie's own notices, which text from the model or a tool can't carry.
- **Denying closes the confirmation at once.** Neither the button nor the typed code can confirm it afterwards.
- **The conversation learns it from Kelpie, not from the model.** A note from Kelpie, like the setup-step notes of ADR-0028, says the owner denied that change. The agent goes on with its task without it.
- **A deny never runs anything.** A forged press could at most cancel a pending change, and ADR-0026's binding already rules out forged presses.
- **On Telegram, nothing changes until it has inline buttons.** The owner declines in words, and the confirmation expires as before.

### 2. Pausing the agent is offered on the notice

The notice also offers the existing pause, as a hold on its own control: "Hold to pause <agent>". It is the same command as the webchat's Pause button. Holding it, instead of clicking, keeps the pause from being a slip next to Confirm and Deny.

### 3. Amber also marks a free tier near its end

Crossing 90% of a free tier (#269) is a decision the owner has to make: keep paying, or turn the feature off. So it uses `--warm`, the color for "the owner needs to act", and joins the strip that counts what waits for the owner. No new color is added.

### 4. Sounds are opt-in, and there is no haptic feedback

- **Three sounds:**
  - an action was confirmed;
  - something was saved to memory;
  - an agent needs the owner.
- **Each is shorter than 300 ms.**
- **They are off by default,** in a setting of their own, separate from the less-motion switch.
- **No sound accompanies a frequent action.**
- **Browser notifications follow the same rule.** They are opt-in, only "an agent needs you" raises one, and only while Kelpie's tab is hidden. This came from the reference check: Hermes Agent rings on every finished turn by default.
- **No vibration.** The web's Vibration API is missing from Safari, so it never reaches an iPhone. The trick that gave iPhones a tap stopped working in iOS 26.5.

### 5. The design system takes the review's patterns

`docs/design-system.md` gains:
- **New patterns:**
  - following the chat;
  - loading;
  - a lost connection;
  - toasts and undo;
  - moving between views;
  - the phone;
  - numbers and trends;
  - the first run;
  - finished work folding into its receipt.
- **Additions to existing patterns:**
  - a confirmation names who asks and shows the evidence;
  - the board gains dragging, delegation and evidence;
  - memory gains its origin, an undo and an off-the-record mode;
  - the roster gains a strip for what waits for the owner, glyphs for each state and a "no response" state.
- **A higher-contrast token set,** a section on voice, and a list of what the research rejected.

## Consequences

- **The Deny button needs its own story** (#361): the button in the webchat, closing the confirmation, and Kelpie's note. Until it ships, a confirmation still waits out its 10 minutes.
- **Two views the owner approved get their own stories**, under the management UI:
  - a day timeline of routines, tasks and runs, with "now" marked (#359);
  - a receipts page of what each agent did, decided and spent (#360).
- **The sound setting and the comfort step are interface work.** They ship with the interface that has settings.
- **The mascot stays open** (ADR-0043 §6). The roster's glyphs and states apply to whatever figure an agent gets.

## Alternatives considered

- **Leave denial to the 10-minute expiry.** It keeps the owner waiting and the agent stalled for a decision he has already made.
- **A Deny that also stops the agent.** It merges two intents. Most of the time the owner refuses one action, not the task.
- **A new color for cost alerts.** It would dilute the one meaning amber has. The owner's decision is exactly what amber signals.
- **Haptics through the iOS trick.** It was patched in iOS 26.5, and it only ever worked on iPhones.

## References

- [ADR-0026](0026-confirmation-by-owner-act.md): the owner's act as a yes; amended in §1.
- [ADR-0028](0028-setup-step-notes.md): notes from Kelpie into a conversation.
- [ADR-0024](0024-fixed-wait-end-of-turn.md) and [ADR-0025](0025-turn-tool-loop.md): the pause.
- [ADR-0043](0043-design-system.md): the design system and its research rule.
- [`docs/design-system.md`](../design-system.md): the patterns this ADR adds.
- [Claude Code's agent view](https://code.claude.com/docs/en/agent-view) and [the Webby Awards 2026 winners](https://www.webbyawards.com/press/press-releases/30th-annual-webby-awards-announce-2026-winners/).
