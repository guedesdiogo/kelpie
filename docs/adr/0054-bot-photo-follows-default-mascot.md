# ADR-0054: A bot's photo follows the agent's default mascot when that default changes

- Status: Accepted
- Date: 2026-10-16
- Issue: [#388](https://github.com/guedesdiogo/kelpie/issues/388)
- The owner approved the plan on #388 on 2026-10-16: «Aprovado o plano da #388. Pode começar.»
- Amends:
  - [ADR-0046](0046-telegram-bot-photo.md) §1: an agent also asks for its bot's photo when its object starts, if the mascot it shows isn't the one it last asked for;
  - [ADR-0049](0049-logo-main-mascot-silhouette.md)'s consequences: the main agent's bot no longer keeps the old Kelpie.

## Context

**A photo was asked for only on two events.** Under ADR-0046 §1, `AgentHost` asks channel-egress for the bot's photo when the bot connects and when the mascot setting changes. It kept nothing about what it asked for.

**A default can change without either event.**
- **A release:** ADR-0049 gave the main agent round ears, big eyes and no collar. A main agent that never picked a mascot kept the old Kelpie on its bot.
- **A role change:** an agent's default follows its role (`mascotFor`), and `Registry.setMain` can move the main role to another agent.

**channel-egress already skips a mascot the bot shows.** `BotPhoto` keeps `shown` for each bot, and its ceiling is unchanged: a new drawing at least 5 minutes after the last one began, and 5 tries for each mascot. Each request resets the tries, so a request sent again on every start would lift that ceiling.

**The deploy wakes every agent.** An object starts whenever it wakes after being evicted. After each deploy, the deep probe wakes the `AgentHost` of every agent the Registry lists (ADR-0033). Waking runs the object's start: its migrations, and any cleanup that follows them.

**The reference projects,** read on #388:
- Hermes Agent's Discord adapter keeps, on disk, a fingerprint of the slash commands it last synced. After each connect, it syncs again only when the fingerprint differs or the last attempt failed.
- Hermes's desktop pushes a bot's face only when the bot has none, so a changed default never reaches it. That is the same gap.

## Decision

### 1. The host remembers what it asked for

- `AgentHost` keeps the mascot it last asked channel-egress to show, as the `botPhoto` row of its `state` table.
- It writes the row only when channel-egress took the request, or answered that the agent has no bot.
- A failure writes nothing, so the object's next start asks again.

### 2. It compares when its object starts

- **Who:** an agent that follows its default mascot. An agent whose owner picked one does nothing at start: its photo follows the setting, as ADR-0046 §1 says.
- **When:** after the migrations, without holding any call.
- **What:**
  - It reads its role in the Registry and works out the mascot it shows now.
  - It asks channel-egress only when that mascot isn't `botPhoto`, or when there is no row.
- **Where it waits:** nowhere. The deploy's probe wakes every listed agent, so a release that changes a default has the agent ask during that deploy.

### 3. A pick made meanwhile wins

When the owner picks a mascot while a default is being read from the Registry, the default isn't asked for. The pick asked for its own photo, and `BotPhoto` keeps the newest request.

## Consequences

- **After a release that changes `KELPIE_MASCOT`,** the main agent's bot shows the new Kelpie with no action from the owner.
- **A role change** moves both agents' photos at their next start.
- **The cost.**
  - Each start of an agent that follows its default reads the Registry once more. Its turns already read it.
  - channel-egress hears from it only when the mascot changed, or when its last request failed. A failure is asked again at each start of the object, until channel-egress takes it or answers that there is no bot.
  - Browser Run draws only where the bot shows another mascot. ADR-0046's ceiling holds, because a request that was taken isn't sent again.
- **The first deploy with this decision** asks once for every agent, since none has a `botPhoto` row yet.
  - An agent without a bot costs a secret read.
  - A bot that already shows its mascot is skipped by `BotPhoto`.
  - A bot that connected before ADR-0046 and never got a photo gets one now.
- **The deep probe's wake can now ask for a photo.** Before, the probe only woke objects.
- **A rollback** to an older build ignores the row. The bot keeps the photo it has until its mascot changes or its bot connects.
- **What the tests cover:** a start after an older default, no request when nothing changed or the owner picked a mascot, a request again after a failure, and a pick made during the lookup. A real bot verifies the photo after the deploy.

## Alternatives considered

- **Comparing at each turn,** as the built-in memory core does (#224). The photo would wait for the owner's next message, and the deploy already wakes every agent.
- **Recording the role beside the mascot,** to compare with no Registry read. A role change would then go unnoticed.
- **Asking on every start and letting `BotPhoto` skip.** Each request resets `BotPhoto`'s tries, which would lift ADR-0046's ceiling for a mascot that keeps failing.
- **Recording the default's version in `KELPIE_MASCOT`.** It covers the main agent's default only, and a version bump is easy to forget.
- **Leaving it as it was,** with the owner picking the mascot again. The owner asked for the photo to follow by itself.

## References

- Issue [#388](https://github.com/guedesdiogo/kelpie/issues/388): the plan and the reference projects' findings.
- **ADRs:**
  - [ADR-0046](0046-telegram-bot-photo.md): the bot's photo;
  - [ADR-0049](0049-logo-main-mascot-silhouette.md): the new default;
  - [ADR-0033](0033-deploy-deep-probe.md): the deploy's deep probe;
  - [ADR-0045](0045-agent-mascot.md): the mascot and its defaults.
- Hermes Agent's [Discord command sync](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/plugins/platforms/discord/adapter.py#L2229-L2246).
