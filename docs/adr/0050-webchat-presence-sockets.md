# ADR-0050: The webchat's sidebar follows each agent through a socket that carries only its presence

- Status: Accepted
- Date: 2026-10-16
- Issue: [#393](https://github.com/guedesdiogo/kelpie/issues/393)
- Decided by the owner on 2026-10-16, approving [#378](https://github.com/guedesdiogo/kelpie/issues/378)'s plan, whose step 3 proposed this: «Aprovo os planos da #378, #379 e #381, incluindo a ADR proposta na #381 e os três preenchimentos da #377.»
- Amends:
  - [ADR-0023](0023-webchat-access-login.md) §2 to §4: the webchat's socket has a second view, admitted the same way;
  - [ADR-0026](0026-confirmation-by-owner-act.md) §3: a Confirm press may also come from that view's socket.

## Context

**The owner asked for the other agents in a sidebar on the desktop** («na versão desktop deve ter os outros agentes na lateral esquerda»). #378 builds it from `docs/design-system.md` §5.9:
- each row shows the agent's mascot at 36 px, its state's glyph and label, and the time;
- a strip above the rows counts the agents waiting for the owner;
- pressing a waiting agent's row opens its request in place, with 5.3's card.

**Today the page hears one agent.** It has one socket, to the owner's webchat conversation with the agent it shows. That conversation is one Durable Object, `<agent>:webchat:<user>`. Its socket carries the conversation itself:
- `history` on connect;
- every `bubble`;
- the turn's `status`, the `wait` and `paused`.

`/webchat/agents` returns each agent's id and name, and nothing about its state or its mascot.

**A confirmation still open after its turn settled reaches no socket.** A confirmation's notice belongs to its turn. History drops the notices of settled turns (`webchat.ts`), so a socket opened later never learns that one is open. The `confirmations` table still holds it until it is used or expires 10 minutes after it was made (ADR-0013). This is why the #377 review found that a reconnect leaves the mascot Idle while a confirmation waits.

**The reference projects.** The research is on #378. Hermes' desktop roster, read at [`848fc0a`](https://github.com/NousResearch/hermes-agent/tree/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c):
- It polls its list every 5 s. It decides who is active from how old the last message is (90 s) and from a worker's heartbeat (150 s) ([`row-helpers.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots/row-helpers.ts#L55-L86)).
- Only the chat in focus gets pushed frames, so only that bot can show that it's thinking ([`row-helpers.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots/row-helpers.ts#L101-L127)).
- Its own code calls the poll "the ONLY unread signal" ([`roster-actions.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots/roster-actions.ts#L53-L63)). Requests from bots out of focus sat unseen until they timed out, which more polling fixed ([`group-chat.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots/group-chat.ts#L40-L47)).

So a roster that guesses lags and misses requests. Linear's agent sessions make the same point from the other side: the server sets `awaitingInput`, and the client never guesses it ([doc](https://linear.app/developers/agent-interaction)). ai-memory and invokta have no roster.

## Decision

### 1. A socket per agent in the sidebar, in a presence view

- **The page opens one for each listed agent but the one it shows,** whose own socket already tells its presence. It opens at most 16; a roster longer than that shows the other rows with their mascot and name, and no state.
- **The same route admits it, the same way.** `/webchat/ws?agent=<id>&view=presence` passes every check of ADR-0023:
  - the Access token;
  - the page's own origin;
  - an agent id the Registry lists;
  - the Directory's `admit`.
  
  Ingress adds `view: "presence"` to the admission it sends. A request with no `view`, or any other value, opens the conversation's socket as before.
- **It reaches the same Durable Object,** the owner's webchat conversation with that agent. So a row shows what that conversation is doing, which is what the owner sees when he opens it.

### 2. What the presence view receives

- **On connect, one `presence` frame** with what the conversation knows now:
  - the turn's current step, its tool's label and activity, and how long ago it began, in ms, so the browser's clock doesn't matter. An object that woke with no turn running is idle;
  - whether the conversation is paused;
  - its open confirmations: each one's id, its notice as the conversation shows it, and how long until it expires, in ms.
- **Then, as they happen:**
  - `status`, as the conversation's own socket gets it;
  - `paused` and `resumed`;
  - `confirmations`, the whole open list, whenever it changes: a notice goes out, a press uses one, or one expires.
- **Never anything else.** No `history`, no `bubble`, no reply's text, and no message of the owner's.
  - The runtime chooses the frames by the socket's admission, not the page. A page that asks for more gets nothing more.
  - The wait and the typing hold belong to the conversation the owner is writing in, so they stay off this view.

### 3. What the presence view may send

- **Only a Confirm press,** for the card that opens in place (5.9). It counts under ADR-0026 §3's rules, unchanged:
  - it must come from the socket of the user who asked;
  - for a confirmation of theirs still open;
  - then the conversation replies with the code for them, and ADR-0013's gate takes it as a typed code, once.
- **Any other frame closes the socket** with 1008.

### 4. The conversation's own socket learns of open confirmations too

- After `history`, it gets the same `confirmations` frame, and again whenever the list changes.
- So a reconnect returns the mascot to Waiting while a confirmation is open (5.12), and the strip and the tab's title count it.

### 5. A row that loses its socket

- **It retries** with the page's backoff (`retryDelay`).
- **After 2 s closed,** it shows Offline (ADR-0047): the row can't vouch for the state any more.
- **When the page loses its own socket,** every row is Offline already, under ADR-0047.

### 6. What it costs

- **A presence socket costs nothing at rest.**
  - It hibernates like the conversation's own socket (ADR-0002). An idle conversation stays asleep.
  - It sends nothing but a press, so it wakes nothing.
- **Opening the page wakes each listed agent's conversation once,** for its `presence` frame. That is one read of its confirmations and nothing from its history.
- **A frame the conversation sends anyway** now also goes to the presence sockets open on it.

This stays within the Workers Paid plan, so it ships on with no switch.

### 7. The agent list names each agent's mascot

`/webchat/agents` adds each agent's mascot, as the conversation's `agent` frame already computes it (ADR-0045): the owner's pick, or its default by its role. Each row then draws the agent's own mascot before its socket opens.

## Consequences

- **[#378](https://github.com/guedesdiogo/kelpie/issues/378) implements it.** Its tests cover:
  - that ingress admits a presence socket exactly as the conversation's own, and passes the view;
  - that a presence socket gets only `presence`, `status`, `paused`, `resumed` and `confirmations`;
  - that it closes on any frame but a Confirm press, and that a press counts only as ADR-0026 says;
  - that both views get `confirmations` on connect and on every change;
  - that the page opens one per row but the open one, at most 16, and shows Offline for a row closed 2 s.
- **A row shows the owner's webchat conversation with that agent,** not its work elsewhere.
  - A turn it runs for a task, or in its Telegram chat, doesn't show there. Those conversations send no steps today.
  - [#394](https://github.com/guedesdiogo/kelpie/issues/394) is the follow-up: an agent's presence across all its conversations.
- **More sockets per page.** One per listed agent, typically under ten, each idle almost all the time.
- **A rollback is safe.** An older ingress ignores `view` and opens the full socket; an older runtime ignores `view` in the admission and sends the full conversation, which the page then drops.

## Alternatives considered

- **A hub Durable Object per owner that every conversation reports to, with one socket to the page.** The research on #378 recommended one channel per owner. It means fewer sockets. But every step of every conversation becomes a call to the hub, which wakes it, and the hub is a new object with its own binding and rollback. Per-agent sockets push the same frames with what exists.
- **The page polls `/webchat/agents` with each agent's state.** Each poll wakes every conversation, the state arrives late, and the cost grows with time instead of with events.
- **A full socket to every agent.** The page would receive every conversation's history and replies to show one line of each.
- **The agent's `AgentHost` gathers its conversations' presence.** It would cover tasks and Telegram, but `AgentHost` holds no live state today, and every conversation would report to it. That is the follow-up's question.

## References

- [ADR-0002](0002-runtime-foundation.md), [ADR-0013](0013-self-configuration.md), [ADR-0023](0023-webchat-access-login.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0045](0045-agent-mascot.md), [ADR-0047](0047-mascot-offline.md)
- `docs/design-system.md` §5.9 (agent presence) and §5.12 (a lost connection)
- [#378](https://github.com/guedesdiogo/kelpie/issues/378), with the mockup and the comparison of the webchat with its references
