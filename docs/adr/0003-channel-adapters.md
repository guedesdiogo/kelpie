# ADR-0003: Kelpie owns its channel adapters and adds channels in a fixed order

- Status: Accepted
- Date: 2026-10-03
- Issue: [#9](https://github.com/guedesdiogo/kelpie/issues/9)
- Amended by: [ADR-0015](0015-single-player-first.md) for phase 1 (single-player)

## Context

The channels differ in what they allow:

| Channel | Inbound | Typing indicator | Constraint |
|---|---|---|---|
| Webchat | WebSocket on a hibernating Durable Object | Both directions | None |
| Telegram | Webhook | 5 s, renewed | About 1 message/s per chat |
| WhatsApp Cloud API | Webhook | 25 s, and it marks the message as read | 1 message every 6 s per user; 24 h window; Meta's terms §4.7 forbid AI as the main function |
| Slack | Events API | None for bots; `assistant.threads.setStatus` | 1 message/s per channel |
| Discord | Free text needs a Gateway WebSocket | 10 s, renewed | Needs an always-on Durable Object per bot |

The Vercel Chat SDK unifies adapters, but its debounce is a `sleep()` inside the handler, which doesn't survive a restart, and its adapters are in beta. Unofficial WhatsApp libraries need a long-lived socket and break WhatsApp's terms.

## Decision

- Kelpie defines its own channel adapter interface (normalize inbound events, send, typing, capabilities), inspired by the Chat SDK. A Chat SDK adapter may be wrapped behind it if one proves useful.
- Channels arrive in this order: webchat, Telegram, WhatsApp Cloud API, Slack, Discord.
- WhatsApp uses the official Cloud API only. Agents there get a bounded business role (scheduling, support triage, an internal helpdesk); general-purpose assistants belong on Telegram, Slack or webchat. Replies there are capped at 3–4 bubbles.
- Discord starts with slash commands. Free text, which needs the gateway Durable Object, comes when it is worth paying for: duration above the included 400k GB-s is billed in US$ 12.50 steps.

## Consequences

- Buffering, splitting and interruption live in the conversation Durable Object ([ADR-0002](0002-runtime-foundation.md)), not in adapters, so every channel gets the same behavior.
- Each adapter declares its capabilities (typing TTL, maximum length, formatting, rate limits). The splitter and the pacer read them.
- No Baileys, whatsapp-web.js or similar libraries, ever.
- Spikes are needed before WhatsApp (does re-sending the typing indicator work between bubbles?) and before Discord free text (does the gateway Durable Object stay resident with only a watchdog alarm?).

## Alternatives considered

- **Adopt the Vercel Chat SDK.** Its debounce isn't durable, and multi-workspace support is limited.
- **Unofficial WhatsApp libraries.** Against WhatsApp's terms; numbers get banned.

## References

- [Viability study §4.5](../viability-study.md#45-channels)
- [Research 06: per-channel sections, §7 capability matrix, §8 Chat SDK](../research/06-chat-channels.md)
- [Research 00: C1, C3 (Discord cost and residency)](../research/00-cross-check.md)
