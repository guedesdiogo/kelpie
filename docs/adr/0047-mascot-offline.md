# ADR-0047: When the page loses its connection, every mascot shows Offline

- Status: Accepted
- Date: 2026-10-16
- Issue: [#380](https://github.com/guedesdiogo/kelpie/issues/380)
- The owner asked on 2026-10-16, relayed by the webchat session: «uma animação do mascote para quando esta "sem conexão", que mostrou acontecer quando esta deslogado, mas tbm quando estiver sem sinal de internet/conexão podemos usar tbm». Then, having seen the lab page: «Aprovo o estado sem conexão como está no laboratório: a ficha, o balão cinza, o glifo, o diálogo com o mascote grande e o pulinho na volta. Mesmo glifo para login expirado, e sem 'última atualização' no rótulo.»
- Amends:
  - [ADR-0045](0045-agent-mascot.md):
    - §4, so the expired-login dialog shows the mascot at 160 px;
    - §6, with a new state;
    - §9, with a `--muted` badge at 36 px;
    - §10, with a grey bubble beside the amber and the red ones, and the plug kept under reduced motion;
  - [ADR-0043](0043-design-system.md)'s presence states (`docs/design-system.md` §5.9), which gain a sixth, Offline: a state of the page, shown wherever presence shows;
  - `docs/design-system.md` §5.12, as #377 set it, so the mascot no longer returns to Idle when the connection is lost.

## Context

**#377 set §5.12: with the connection lost, "the mascot returns to Idle at once".** The page hears nothing more of the turn, so it can't vouch for work it no longer sees (rule 7). Idle says something too, though: that the agent is free, which the page can't see either.

**The webchat's mockup already says what happened.** On the «Sem conexão» and «Login expirado» screens of [#378](https://github.com/guedesdiogo/kelpie/issues/378)'s mockup, the header and every agent in the side list read "sem conexão".

**The research on #380:**
- No award-winning product documents an offline character.
- **Shipped work keeps offline apart:**
  - Chrome shows its dinosaur for offline only;
  - Apple gives "not connected" its own icon, apart from Sleep;
  - Telegram replaces the presence line with "Waiting for network…" and never shows a presence it can't see.
- **Grey is the neutral color,** as in Slack.
- **Hermes greys a face but keeps its mood,** idle or working, which claims what it can't see.

## Decision

### 1. A state of its own: Offline

- **When:** the page lost its connection. That is when §5.12's banner enters, 2 s after the loss, or when the expired-login dialog opens.
  - Every mascot on the page that shows a state shows it at once, since the page sees none of the agents. The switcher and the task card show no state, so they don't change.
  - It says what the page knows, that the connection is gone, and nothing about a turn (rule 7).
- **Pose:**
  - it holds the plug that came out, by its loose cord, in a mitten, with its eyes open on it and its brows up;
  - beside it, a solid grey bubble (`--muted`) shows a struck-through plug.
  - It is neither amber, which is Waiting, nor red, which is Error, so it doesn't read as the agent asking or failing. The solid outline and the glyph keep it apart from No response's dashed `…` bubble.
- **Announcement:** the plug comes out of the body, drops a little and swings to rest, and the bubble pops.
- **Repertoire in Alive, a calm one:** it blinks, glances, looks at the plug, tries the plug in the air, shakes it, looks around, sighs and yawns.
  - Gestures come 4 to 8 s apart, and it never hops.
  - Nothing in it pleads or trembles, which would blame the agent for the network.
- **At 36 px:** a `--muted` badge with a `--surface` ring. §5.9's glyph, a struck-through circle, and the label "no connection" carry the state. The label shows no time.
- **Reduced motion and Still:** the pose, the plug and the bubble, with the 150 ms crossfade.

### 2. One state for both causes

No internet, no server and an expired login show the same state and glyph. The banner says the connection is lost, and the dialog says the login expired: the page can't tell a missing network from a missing server.

### 3. The expired-login dialog shows the mascot at 160 px

The conversation's agent's mascot, holding its plug, above the dialog's text. Behind the dialog, every mascot that shows a state shows Offline too.

### 4. Back

When the connection comes back, the mascot plays a return announcement, then shows the state the history brings (§5.12), such as Waiting while a confirmation is still open.
- **The announcement:** the plug clicks home, with a small hop and a blink, under 1 s.
- **Where it plays:** in Alive and in States only, at every size, the roster's included, like any announcement.
- **In Still:** the new pose comes with the crossfade.

## Consequences

- **`docs/design-system.md` changes in the same pull request:**
  - §5.12;
  - §5.19: its row, the return, the bubble, the roster's badge, the dialog's size and Still;
  - §5.9: its row;
  - §9.
- **The webchat implements it in #378.** The engine gains:
  - the plug, as an object in the mittens;
  - the grey bubble and its glyph;
  - three gestures.

  The lab page's engine on #380 is the reference.
- **Offline is the only state that comes from the page rather than from an agent.** ADR-0045 §6's life in place covers it, with its three guards.
- **Unaffected:**
  - the Telegram bot's photo (ADR-0046), which shows the mascot at rest;
  - agents seen from another channel, which never show this page's state.

## Alternatives considered

- **Idle, as #377 had it.** It reads as free, a state the page can't see.
- **Dozing.** Closed eyes read as asleep.
- **Greying the agent's last face,** as Hermes does. It keeps a mood the page can't see.
- **Stopping after a few gestures,** as Chrome's dinosaur does after 3 blinks. ADR-0045 §6 keeps every mascot alive; this repertoire is a calm one instead.
- **A key glyph for an expired login.** The owner chose one glyph for both.
- **"Last updated 2 min ago" in the label.** The owner declined it.

## References

- Issue [#380](https://github.com/guedesdiogo/kelpie/issues/380): the request, the research and the owner's approval.
- [The lab page](https://claude.ai/artifact/DRfN8ZiCg7L1UX9QbdBUaU), on the webchat's engine.
- [ADR-0045](0045-agent-mascot.md), the mascot; [ADR-0043](0043-design-system.md), the design system and rule 7.
