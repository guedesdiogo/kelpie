# ADR-0050: The webchat's sidebar follows each agent through a socket that carries only its presence

- Status: Proposed
- Date: 2026-10-16
- Issue: [#393](https://github.com/guedesdiogo/kelpie/issues/393)
- Proposed in step 3 of [#378](https://github.com/guedesdiogo/kelpie/issues/378)'s plan. The owner approved that plan on 2026-10-16. This text goes further than step 3, so it waits for his yes on #393 (Consequences).
- Amends:
  - [ADR-0023](0023-webchat-access-login.md) §2 to §4: the webchat's socket has a second view, admitted the same way;
  - [ADR-0026](0026-confirmation-by-owner-act.md) §3, so a press names its agent and may come from that view, and the line in its Consequences that a notice doesn't come back once its turn has settled;
  - [ADR-0047](0047-mascot-offline.md) §1, so one row whose own socket is lost shows Offline.

## Context

**The owner asked for the other agents in a sidebar on the desktop** («na versão desktop deve ter os outros agentes na lateral esquerda»). #378 builds it from `docs/design-system.md` §5.9:
- each row shows the agent's mascot at 36 px, its state's glyph and label, and the time;
- a strip above the rows counts the agents waiting for the owner;
- a waiting agent's request opens in place, with 5.3's card.

**Today the page hears one agent.** It has one socket, to the owner's webchat conversation with the agent it shows. That conversation is one Durable Object, `<agent>:webchat:<user>`. Its socket carries the conversation itself:
- `history` on connect;
- every `bubble`;
- the turn's `status`, the `wait` and `paused`.

`/webchat/agents` returns each agent's id, name and whether it is Master. It returns nothing about the agent's state or its mascot.

**A confirmation still open after its turn settled reaches no socket.**
- A confirmation's notice belongs to its turn.
- The transcript replays only the sent notices of a turn still running (`conversation-agent.ts`, `#transcript`). So a socket opened later never learns that one is open.
- The `confirmations` table still holds it until a later turn uses it, or until it expires, 10 minutes after it was last shown (ADR-0026 §3).
- This is why the #377 review found that a reconnect leaves the mascot Idle while a confirmation waits.

**Two facts about today's code shape this decision:**
- **Every frame goes to every socket of the conversation.** Nothing reads a connection's admission before sending.
- **A confirmation's id is a counter of its own conversation.** Every conversation's first confirmation is 1, and a press names only that id.

**The reference projects.** The research is on #378. Hermes' desktop roster, read at [`848fc0a`](https://github.com/NousResearch/hermes-agent/tree/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c):
- **It polls its list every 5 s** ([`data.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots/data.ts#L887-L896)).
- **It decides who is active** from how old the last message is (90 s) and from a worker's heartbeat (150 s) ([`row-helpers.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots/row-helpers.ts#L55-L86)).
- **Only the chat in focus gets pushed frames,** so only that bot can show that it's thinking ([`row-helpers.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots/row-helpers.ts#L101-L127)).
- **A prompt raised in a group member's hidden session had nowhere to be answered,** and a poll of its turns now mirrors it ([`group-chat.ts`](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/apps/desktop/src/plugins/hermes-bots/group-chat.ts#L40-L47)).

So a roster that guesses lags and misses requests. Linear's agent sessions make the same point from the other side: the server sets `awaitingInput`, and the client never guesses it ([doc](https://linear.app/developers/agent-interaction)). ai-memory and invokta have no roster.

## Decision

### 1. A socket per agent in the sidebar, in a presence view

- **The page opens one for each listed agent but the one it shows,** whose own socket already tells its presence.
  - It follows at most 16, in the Registry's order.
  - Past 16, the rows show their mascot and name with no state, and the list says once that it can't follow them.
- **The same route admits it, the same way.** `/webchat/ws?agent=<id>&view=presence` passes every check of ADR-0023:
  - the Access token;
  - the page's own origin;
  - an agent id the Registry lists;
  - the Directory's `admit`.
- **Ingress passes the view in the admission it builds.**
  - With no `view`, the request opens the conversation's socket as before.
  - With `presence`, ingress adds `view: "presence"`.
  - Any other value gets 400.
  - The runtime closes a socket whose admission names a view it doesn't know, with 1008.
- **The view is the page's request, not a grant.** Today the owner is the one user and may open either view, so asking for less gains nothing. If the webchat ever admits other users (ADR-0015), the view becomes a grant the Directory gives.
- **It reaches the same Durable Object,** the owner's webchat conversation with that agent. So a row shows what that conversation is doing.
- **The runtime keeps at most 8 presence sockets per conversation.** A ninth closes the oldest with 1013, so a leaking tab can't grow them.

### 2. What the presence view receives

**Every frame the conversation sends goes through one function.** It reads the connection's admission and sends only what that connection's view allows. A connection with no admission gets nothing. Nothing else iterates the conversation's sockets.

**On connect, the presence view gets one `presence` frame** with what the conversation knows now:
- **The turn's current step,** its tool's label and activity, and how long ago the turn began, in ms. The conversation will start keeping the latest step in memory, set with each step and cleared when the turn settles. The ms count means the browser's clock doesn't matter.
  - An object that woke with no turn running is idle.
  - One woken by an eviction mid-turn reads the running turn from its table. It says working without a label until the recovered turn's next step.
- **Whether its latest turn failed,** for 5.9's Error.
- **Whether it is paused.**
- **Its open confirmations,** newest first, at most 10, with the count of any others. "Open" means:
  - not used;
  - not expired;
  - asked by this socket's user;
  - its notice sent, which is an outbox row for it marked sent. A confirmation from a turn the owner interrupted never shows.

  Each one carries its id, the summary its tool wrote, in full, and how long until it expires, in ms.

**Then, as they happen:**
- `status`, as the conversation's own socket gets it;
- `status` idle when any turn settles, a delivered one included. The conversation's own socket ends the step on the reply's bubble, which this view doesn't get;
- `failed`, when a turn ends with the failure notice;
- `paused` and `resumed`;
- `confirmations`, the whole open list as above, when it changes:
  - a notice is sent;
  - a later turn uses a confirmation;
  - one is shown again, with a new expiry.

  No frame marks an expiry: the page drops a confirmation when its time runs out, and the conversation checks again at the press. So no alarm wakes the conversation for it.
- `confirmation`, the answer to a press, to the socket that sent it.

**Never anything else.** No `history`, no `bubble`, no `typing`, no `wait`, no `agent`, no reply's text, and no message of the owner's.

### 3. What the presence view may send

- **Only what 5.3's card does, each frame naming its agent:**
  - `confirm`;
  - `pause`, the card's hold (ADR-0044);
  - `deny`, once #361 builds it.
- **The rules for each:**
  - A frame counts only if its agent is the socket's admitted agent. A confirmation's id is its own conversation's counter, so an id alone could confirm another agent's change.
  - A press counts under ADR-0026 §3: from the socket of the user who asked, for a confirmation of theirs still open. Then the conversation replies with the code for them, and ADR-0013's gate takes it as a typed code, once.
  - A pause works as it does from the conversation (#134).
- **The conversation's own socket names its agent on these frames too.** A frame there that names another agent is refused.
- **Anything else closes the socket with 1008.** The view is checked first, before any other frame is read: `message`, `typing`, binary or malformed frames, and the SDK's own frames.

### 4. The conversation's own socket learns of open confirmations too

- After `history`, it gets the same `confirmations` frame, and again whenever the list changes.
- So a reconnect returns the mascot to Waiting while a confirmation is open (5.12), and the strip and the tab's title count it.
- **The page draws the card again.** A confirmation open after its turn settled shows its card at the end of the thread, with its time. This amends ADR-0026's line that a notice doesn't come back once its turn has settled.

### 5. How the page keeps the rows honest

- **Each presence socket has its own handler,** which takes only the frames of §2. A frame of any other kind is dropped, so nothing from another conversation can reach the thread.
- **A row's state starts unknown,** and shows none until its `presence` frame arrives. It is never Idle by default.
- **A card's actions** go over the socket its card came from, never over the open conversation's.
  - A press within 400 ms of the card drawing, or redrawing, is ignored.
  - An open card's content never changes in place.
- **A row that loses its socket:**
  - it retries with the page's backoff (`retryDelay`);
  - the backoff starts again when the page's own socket reconnects, or on "Try now";
  - after 2 s closed, it shows Offline (ADR-0047), because the row can't vouch for the state any more.
- **A refusal doesn't retry.** A socket closed with 1008, or refused at the upgrade, isn't retried. The page reloads the agent list once for all rows, and drops the rows no longer listed.
- **Retries pause while the page is hidden.** The login check runs once for the page, not once per row.
- **When the page loses its own socket,** every row is Offline already (ADR-0047).
- **The notices' text stays on the page.** It stays out of the tab's title, notifications and the tab's storage. Names and summaries are set as text, never as markup.

### 6. What it costs

- **A presence socket costs nothing at rest.**
  - It hibernates like the conversation's own socket (the Agents SDK accepts it with the hibernation API, ADR-0034).
  - An idle conversation stays asleep.
  - It sends only the card's actions, so it wakes nothing on its own.
- **Opening the page wakes each followed agent's conversation once,** for its `presence` frame. That is one read of its turns and its confirmations, and nothing from its history.
- **A frame the conversation sends anyway** now also goes to the presence sockets open on it.

This stays within the Workers Paid plan, so it ships on with no switch.

### 7. The agent list names each agent's mascot

- `/webchat/agents` adds each agent's mascot, as the conversation's `agent` frame computes it (ADR-0045): the owner's pick, or its default by its role.
  - Each row then draws the agent's own mascot before its socket opens.
  - So does 5.21's switcher on the phone, which opens no presence sockets.
- **Ingress reads it through a read-only entrypoint of conversation-runtime,** `AgentLooks`, as it reaches `SetupEvents` and `DeployProbe`.
  - It takes a list of agent ids and returns each one's mascot, checked with `parseMascot`.
  - It does nothing else.
- **Ingress still binds no `AgentHost`,** so it gets no write path to any agent.

## Consequences

- **The owner's yes.** This text adds to step 3 of #378's plan, which proposed status, wait and open-confirmation frames:
  - the cap of 16;
  - `paused`, `resumed` and `failed` in place of `wait`;
  - the card's actions on the view;
  - the card drawn again in the thread;
  - Offline for one row;
  - the mascots in the list.

  It becomes Accepted once he approves it on #393.
- **[#378](https://github.com/guedesdiogo/kelpie/issues/378) implements it.** Its tests cover:
  - **ingress:**
    - a presence socket is admitted exactly as the conversation's own, from the page's origin only, and passes the view;
    - an unknown view gets 400;
    - `AgentLooks` is its one new binding, and the list returns only closed-enum mascot values;
  - **the frames:**
    - one function chooses every frame by view, and a new frame type fails a test until someone classifies it;
    - a presence socket gets only §2's frames, before and after a hibernation wake;
    - a presence socket gets idle after a delivered turn, and `failed` after a failed one;
  - **what the view may send:**
    - a frame naming another agent is refused, and a press of one conversation's id over another's socket confirms nothing in either;
    - anything else closes the socket;
    - a press counts only under ADR-0026's rules;
  - **open confirmations:**
    - "open" means a notice sent: an interrupted turn's confirmation never shows, and another user's never does;
    - both views get `confirmations` on connect and on each change;
  - **the page:**
    - a presence socket's other frames change nothing;
    - a row starts unknown;
    - a card's press goes over its row's socket;
    - Offline shows for a row closed 2 s;
    - there is no retry after a refusal;
    - one socket per row survives reconnects.
- **`docs/design-system.md` changes with #378:**
  - 5.3, for the card in a row;
  - 5.9:
    - a waiting row's state opens its request;
    - one row's Offline;
    - the order the rows are followed in;
  - 5.12, for the card drawn again after a reconnect.
- **A row shows the owner's webchat conversation with that agent,** not its work elsewhere.
  - A turn it runs for a task, or in its Telegram chat, doesn't show there. Those conversations send no steps today.
  - [#394](https://github.com/guedesdiogo/kelpie/issues/394) is the follow-up: an agent's presence across all its conversations.
- **ADR-0040's Continue offer** is a second kind of open notice beside confirmations. When it is built, it joins the `confirmations` frame and the card, under the same rules.
- **More sockets per page:** one per followed agent, typically under ten, each idle almost all the time.
- **A rollback keeps the data where it was, at a one-time cost.** The owner may open either view, so neither direction exposes anything new:
  - an older ingress ignores `view` and opens the full socket;
  - an older runtime ignores `view` in the admission and sends the full conversation.

  Then each followed agent's socket reads its history on load once, and the page's presence handler drops those frames (§5).
- **Residual, as before:** ADR-0023 checks the Access token at the upgrade only. A socket open for days, of either view, still takes a press after the login expires. More sockets widen that, and the page's login check stays the remedy.

## Alternatives considered

- **A hub Durable Object per owner that every conversation reports to, with one socket to the page.**
  - The research on #378 recommended one channel per owner, and it means fewer sockets.
  - But every step of every conversation becomes a call to the hub, which wakes it.
  - The hub is also a new object with its own binding and rollback.
  - Per-agent sockets push the same frames with what exists.
- **The page polls `/webchat/agents` with each agent's state.** Each poll wakes every conversation, the state arrives late, and the cost grows with time instead of with events.
- **A full socket to every agent.** The page would receive every conversation's history and replies to show one line of each.
- **The agent's `AgentHost` gathers its conversations' presence.** It would cover tasks and Telegram, but `AgentHost` holds no live state today, and every conversation would report to it. That is the follow-up's question.
- **Bind `AgentHost` on ingress to read the mascots.** Its `wrangler.jsonc` keeps it out on purpose: that binding would let ingress configure any agent.
- **Keep Confirm the only action from a row.** The card's hold would then close the socket, and 5.3's card would lose an answer in the one place it opens outside the thread.
- **An alarm per confirmation, to tell the page when it expires.** It wakes every idle conversation 10 minutes after each request, for what the page can count from `expiresInMs`.

## References

- [ADR-0002](0002-runtime-foundation.md), [ADR-0013](0013-self-configuration.md), [ADR-0015](0015-single-player-first.md), [ADR-0023](0023-webchat-access-login.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0034](0034-agents-sdk-0-28.md), [ADR-0040](0040-continue-at-the-tool-bound.md), [ADR-0044](0044-design-system-review.md), [ADR-0045](0045-agent-mascot.md), [ADR-0047](0047-mascot-offline.md)
- `docs/design-system.md` §5.3 (confirm an action), §5.9 (agent presence), §5.12 (a lost connection) and §5.21 (the switcher)
- [#378](https://github.com/guedesdiogo/kelpie/issues/378), with the mockup, the comparison of the webchat with its references, and the sidebar's research
- The clean-context review and the security review of this text, on [#393](https://github.com/guedesdiogo/kelpie/issues/393)
