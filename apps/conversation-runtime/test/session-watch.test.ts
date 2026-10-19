import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RunnerVpsSession, RunnerVpsWait, RunnerWaitsOutcome } from "@kelpie/channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentHost,
  replaceIdentitySourcesForTesting,
  replaceRunnerSessionsForTesting,
} from "../src/agent-host/agent-host.ts";
import {
  checkWaits,
  MAX_NOTICES_PER_CHECK,
  MAX_OUTDATED,
  MAX_TOLD,
  NEW_WATCH,
  OUTDATED_PAUSE_MS,
  type SessionWatch,
  shouldArm,
  TOLD_KEEP_MS,
  WAIT_JOIN_MS,
  WAIT_OVERLAP_MS,
  WATCH_INTERVAL_S,
  type WatchIO,
} from "../src/agent-host/session-watch.ts";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { type FakeWorld, fakeWorld } from "./fakes.ts";

// Kelpie's check of the waits on the owner (ADR-0057 §5, #434): while the runner is connected,
// Master's AgentHost asks channel-egress's RunnerSessions for the open waits once a minute, with an
// overlapping `since`, and tells the owner of each new one once. It keeps only which waits it told.

const MINUTE = 60_000;
/** The runner's clock in its answers, and the Worker's, which runs half a minute ahead of it. */
const NOW = Date.UTC(2026, 9, 18, 12);
const CLOCK = NOW + 30_000;

const A = "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f";
const B = "1a2b3c4d-0000-4000-8000-000000000001";

const wait = (sessionId: string, openedAt: number, fields: Partial<RunnerVpsWait> = {}) =>
  ({
    sessionId,
    kind: "permission",
    openedAt,
    title: "Fix the login flow",
    repository: "kelpie",
    ...fields,
  }) satisfies RunnerVpsWait;

const ok = (waits: RunnerVpsWait[], now = NOW): RunnerWaitsOutcome => ({
  ok: true,
  now,
  waits,
  truncated: false,
});

/** A watch's outside world: the runner's answers in turn, and a record of what it asked and told. */
function fakeIO(answers: (RunnerWaitsOutcome | Error)[], { master = true, tells = true } = {}) {
  const asked: number[] = [];
  const told: RunnerVpsWait[] = [];
  const io: WatchIO & { master: boolean | Error; tells: boolean } = {
    master,
    tells,
    async isMaster() {
      if (io.master instanceof Error) throw io.master;
      return io.master;
    },
    async waits(since) {
      asked.push(since);
      const next = answers.shift() ?? ok([]);
      if (next instanceof Error) throw next;
      return next;
    },
    async tell(one) {
      if (!io.tells) return false;
      told.push(one);
      return true;
    },
  };
  return { io, asked, told };
}

/** Runs `checkWaits` once for each clock, from `watch`, and gives the last watch. */
async function checks(io: WatchIO, clocks: number[], watch: SessionWatch = NEW_WATCH) {
  let current = watch;
  for (const clock of clocks) current = await checkWaits(current, io, clock);
  return current;
}

afterEach(() => {
  replaceIdentitySourcesForTesting(undefined);
  replaceRunnerSessionsForTesting(undefined);
  replacePortsForTesting(undefined);
  vi.restoreAllMocks();
});

describe("the check of the VPS's waits", () => {
  it("asks from two minutes before its first check, then before the runner's last answer", async () => {
    const { io, asked } = fakeIO([ok([]), ok([], NOW + MINUTE)]);
    const watch = await checks(io, [CLOCK, CLOCK + MINUTE, CLOCK + 2 * MINUTE]);
    expect(WAIT_OVERLAP_MS).toBe(2 * MINUTE);
    // The first on the Worker's clock, then each on the runner's own, which the answer gives.
    expect(asked).toEqual([
      CLOCK - WAIT_OVERLAP_MS,
      NOW - WAIT_OVERLAP_MS,
      NOW + MINUTE - WAIT_OVERLAP_MS,
    ]);
    expect(watch.stopped).toBeNull();
  });

  it("tells each wait once, though the overlap asks for it again", async () => {
    const first = wait(A, NOW - 10_000);
    const second = wait(B, NOW + 50_000, { kind: "question" });
    const { io, told } = fakeIO([
      ok([first]),
      ok([first, second], NOW + MINUTE),
      ok([first, second]),
    ]);
    const watch = await checks(io, [CLOCK, CLOCK + MINUTE, CLOCK + 2 * MINUTE]);
    expect(told).toEqual([first, second]);
    // It keeps only which waits it told: each one's session and opening time.
    expect(watch.told).toEqual([
      [A, NOW - 10_000],
      [B, NOW + 50_000],
    ]);
    expect(JSON.stringify(watch)).not.toContain("Fix the login flow");
  });

  it("takes one session's waits less than 60 s apart for one, and further apart for two", async () => {
    expect(WAIT_JOIN_MS).toBe(60_000);
    // The runner moves a wait's opening earlier once, when a hook's line lands after a check saw
    // its session file (ADR-0059 §2): still one wait. The next prompt, later, is another.
    const opened = wait(A, NOW - 5_000);
    const movedEarlier = wait(A, NOW - 35_000);
    const nextPrompt = wait(A, NOW + 90_000);
    const otherSession = wait(B, NOW - 5_000);
    const { io, told } = fakeIO([
      ok([opened]),
      ok([movedEarlier, otherSession], NOW + MINUTE),
      ok([nextPrompt], NOW + 2 * MINUTE),
    ]);
    await checks(io, [CLOCK, CLOCK + MINUTE, CLOCK + 2 * MINUTE]);
    expect(told).toEqual([opened, otherSession, nextPrompt]);
  });

  it("forgets what it told after a day, and keeps at most a thousand", async () => {
    expect(TOLD_KEEP_MS).toBe(24 * 60 * MINUTE);
    const later = NOW + TOLD_KEEP_MS + 5 * MINUTE;
    const { io } = fakeIO([ok([wait(B, later - MINUTE)], later)]);
    const watch = await checks(io, [later], {
      ...NEW_WATCH,
      since: later - 3 * MINUTE,
      told: [
        [A, NOW],
        [A, later - 10 * MINUTE],
      ],
    });
    expect(watch.told).toEqual([
      [A, later - 10 * MINUTE],
      [B, later - MINUTE],
    ]);
    // It never asks further back than it remembers.
    expect(watch.since).toBe(later - WAIT_OVERLAP_MS);

    const full: [string, number][] = Array.from({ length: MAX_TOLD }, (_, index) => [
      A,
      NOW - MAX_TOLD + index,
    ]);
    const crowded = fakeIO([ok([wait(B, NOW)])]);
    const kept = await checks(crowded.io, [CLOCK], { ...NEW_WATCH, told: full });
    expect(kept.told).toHaveLength(MAX_TOLD);
    expect(kept.told[0]).toEqual([A, NOW - MAX_TOLD + 1]);
    expect(kept.told.at(-1)).toEqual([B, NOW]);
  });

  it("asks again for the waits it couldn't tell, and tells a few at most in one check", async () => {
    const waits = Array.from({ length: 5 }, (_, index) =>
      wait(`${index}0000000-0000-4000-8000-000000000000`, NOW - (10 - index) * MINUTE),
    );
    const { io, told, asked } = fakeIO([ok(waits), ok(waits, NOW + MINUTE)]);
    io.tells = false;
    const failed = await checks(io, [CLOCK]);
    // Its first wait waits for the next check: it is asked for again, though older than the overlap.
    expect(failed.since).toBe(NOW - 10 * MINUTE);
    expect(failed.told).toEqual([]);

    io.tells = true;
    const next = await checks(io, [CLOCK + MINUTE], failed);
    expect(asked[1]).toBe(NOW - 10 * MINUTE);
    expect(MAX_NOTICES_PER_CHECK).toBe(3);
    expect(told).toEqual(waits.slice(0, 3));
    expect(next.since).toBe(NOW - 7 * MINUTE);

    // Never further back than a day.
    const old = wait(A, NOW - TOLD_KEEP_MS - 10 * MINUTE);
    const stale = fakeIO([ok([old])], { tells: false });
    expect((await checks(stale.io, [CLOCK])).since).toBe(NOW - TOLD_KEEP_MS);
  });

  it.each(["not_configured", "not_connected", "refused"] as const)(
    "stops while the runner isn't connected: %s",
    async (reason) => {
      const { io, told } = fakeIO([{ ok: false, reason }]);
      const watch = await checks(io, [CLOCK]);
      expect(watch.stopped).toEqual({ reason, at: CLOCK });
      expect(told).toEqual([]);
    },
  );

  it("stops after three outdated answers in a row", async () => {
    expect(MAX_OUTDATED).toBe(3);
    const outdated = { ok: false, reason: "outdated" } as const;
    const { io } = fakeIO([outdated, outdated, { ok: false, reason: "unreachable" }, outdated]);
    const going = await checks(io, [CLOCK, CLOCK + MINUTE, CLOCK + 2 * MINUTE, CLOCK + 3 * MINUTE]);
    // Another answer between them starts the count again.
    expect(going).toMatchObject({ outdated: 1, stopped: null });
    const again = fakeIO([outdated, outdated, outdated]);
    expect(await checks(again.io, [CLOCK, CLOCK + MINUTE, CLOCK + 2 * MINUTE])).toMatchObject({
      outdated: 3,
      stopped: { reason: "outdated", at: CLOCK + 2 * MINUTE },
    });
  });

  it("goes on through a runner it can't reach, and a call that fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const since = NOW - 5 * MINUTE;
    for (const answer of [
      { ok: false, reason: "unreachable" } as const,
      { ok: false, reason: "store_unavailable" } as const,
      new Error("binding gone"),
    ]) {
      const { io } = fakeIO([answer]);
      const watch = await checks(io, [CLOCK], { ...NEW_WATCH, since, outdated: 1 });
      expect(watch, String(answer)).toMatchObject({ since, stopped: null });
    }
  });

  it("stops once its agent isn't Master, and skips a check while that can't be read", async () => {
    const { io, asked } = fakeIO([ok([wait(A, NOW)])], { master: false });
    expect((await checks(io, [CLOCK])).stopped).toEqual({ reason: "not_master", at: CLOCK });
    io.master = new Error("the Registry didn't answer");
    expect(await checks(io, [CLOCK], NEW_WATCH)).toEqual(NEW_WATCH);
    expect(asked).toEqual([]);
  });

  it("starts again with Master's turn, but not within an hour of an outdated runner", () => {
    expect(OUTDATED_PAUSE_MS).toBe(60 * MINUTE);
    expect(shouldArm(NEW_WATCH, CLOCK)).toBe(true);
    const stopped = (reason: "not_connected" | "outdated" | "not_master") => ({
      ...NEW_WATCH,
      stopped: { reason, at: CLOCK },
    });
    expect(shouldArm(stopped("not_connected"), CLOCK)).toBe(true);
    expect(shouldArm(stopped("not_master"), CLOCK)).toBe(true);
    expect(shouldArm(stopped("outdated"), CLOCK + OUTDATED_PAUSE_MS - 1)).toBe(false);
    expect(shouldArm(stopped("outdated"), CLOCK + OUTDATED_PAUSE_MS)).toBe(true);
  });
});

describe("Master's AgentHost watching the VPS's waits (#434)", () => {
  const host = (id: string) => env.AGENT_HOST.getByName(id);
  const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);

  /** Identity sources where each listed agent has its role. */
  function roster(roles: Record<string, "main" | "specialist">) {
    replaceIdentitySourcesForTesting({
      agent: async (id) => {
        const role = roles[id];
        return role ? { name: id, role, owner: null } : null;
      },
      describe: async () => ({ provider: "anthropic", tier: "cheap", route: [] }),
      specialists: async () => [],
    });
    return roles;
  }

  /** A RunnerSessions whose waits come from `sessions` as the runner derives them, recording calls. */
  function runner(outcome: () => RunnerWaitsOutcome) {
    const asked: number[] = [];
    replaceRunnerSessionsForTesting({
      async waits(since) {
        asked.push(since);
        return outcome();
      },
    });
    return asked;
  }

  const watchSchedules = (id: string) =>
    runInDurableObject(host(id), async (instance: AgentHost) =>
      (await instance.listSchedules()).filter((schedule) => schedule.callback === "watchSessions"),
    );

  const watchOf = (id: string) =>
    runInDurableObject(host(id), (_instance: AgentHost, state) => {
      const [row] = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM state WHERE key = 'sessionWatch'")
        .toArray();
      return row ? (JSON.parse(row.value) as SessionWatch) : undefined;
    });

  function use(world: FakeWorld): FakeWorld {
    replacePortsForTesting(world.ports);
    return world;
  }

  /** A conversation of the agent's with the owner, bound by their message and recorded by a turn. */
  async function conversation(agentId: string, channel: "telegram" | "webchat", threadId: string) {
    const name = `${agentId}:${channel}:${threadId}`;
    await agent(name).ingest({
      agentId,
      providerMessageId: `${name}-m1`,
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: "hello there, how are you doing today?",
      destination: { channel, threadId },
      sentAt: Date.UTC(2026, 9, 18, 11),
      timeZone: null,
    });
    await runInDurableObject(agent(name), async (instance: ConversationAgent) => {
      for (const schedule of instance.getSchedules()) await instance.cancelSchedule(schedule.id);
    });
    await host(agentId).turnConfig(name);
    return name;
  }

  it("starts with Master's turns, once a minute, and never with a specialist's", async () => {
    roster({ "watch-main": "main", "watch-specialist": "specialist" });
    runner(() => ok([]));
    await host("watch-main").turnConfig();
    await host("watch-main").turnConfig();
    const schedules = await watchSchedules("watch-main");
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ type: "interval", intervalSeconds: WATCH_INTERVAL_S });
    expect(WATCH_INTERVAL_S).toBe(60);
    await host("watch-specialist").turnConfig();
    expect(await watchSchedules("watch-specialist")).toEqual([]);
  });

  it("tells the owner's conversation of each new wait once, on Telegram before the webchat", async () => {
    roster({ "watch-tell": "main" });
    const world = use(fakeWorld([]));
    const now = Date.now();
    let waits = [wait(A, now - 5_000, { title: "Fix\nthe login" })];
    const asked = runner(() => ok(waits, now));
    await conversation("watch-tell", "telegram", "chat-1");
    // The webchat's turn is the latest, but a notice reaches the owner's phone on Telegram.
    await conversation("watch-tell", "webchat", "u-owner");

    await host("watch-tell").watchSessions();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(now - WAIT_OVERLAP_MS - 10_000);
    expect(asked[0]).toBeLessThanOrEqual(Date.now() - WAIT_OVERLAP_MS);
    expect(world.sends).toEqual([
      {
        text: 'A Claude Code session on your VPS is waiting for your permission: "Fix the login", repository "kelpie".',
        silent: false,
      },
    ]);

    waits = [...waits, wait(B, now, { kind: "question", title: null, repository: null })];
    await host("watch-tell").watchSessions();
    expect(asked[1]).toBe(now - WAIT_OVERLAP_MS);
    expect(world.sends.map((sent) => sent.text)).toEqual([
      'A Claude Code session on your VPS is waiting for your permission: "Fix the login", repository "kelpie".',
      "A Claude Code session on your VPS is waiting for your answer: untitled.",
    ]);
    expect((await watchOf("watch-tell"))?.told).toEqual([
      [A, now - 5_000],
      [B, now],
    ]);
  });

  it("tells nothing of idle or ended sessions, whose waits the runner doesn't list", async () => {
    roster({ "watch-quiet": "main" });
    const world = use(fakeWorld([]));
    const now = Date.now();
    const sessions: Pick<RunnerVpsSession, "id" | "state" | "since" | "title">[] = [
      { id: A, state: "idle", since: now - 5_000, title: "Idle one" },
      { id: B, state: "ended", since: now - 5_000, title: "Ended one" },
      {
        id: "2b3c4d5e-0000-4000-8000-000000000002",
        state: "waiting_answer",
        since: now,
        title: "Asks",
      },
    ];
    // As the runner does: an open wait only for a session that waits on the owner.
    runner(() =>
      ok(
        sessions.flatMap((session) =>
          session.state === "waiting_answer" || session.state === "waiting_permission"
            ? [wait(session.id, session.since ?? now, { kind: "question", title: session.title })]
            : [],
        ),
        now,
      ),
    );
    await conversation("watch-quiet", "telegram", "chat-1");
    await host("watch-quiet").watchSessions();
    expect(world.sends.map((sent) => sent.text)).toEqual([
      'A Claude Code session on your VPS is waiting for your answer: "Asks", repository "kelpie".',
    ]);
  });

  it("stops while the runner isn't connected, and starts again with Master's next turn", async () => {
    roster({ "watch-off": "main" });
    let outcome: RunnerWaitsOutcome = { ok: false, reason: "not_connected" };
    const asked = runner(() => outcome);
    await host("watch-off").turnConfig();
    await host("watch-off").watchSessions();
    expect(asked).toHaveLength(1);
    expect(await watchSchedules("watch-off")).toEqual([]);
    expect((await watchOf("watch-off"))?.stopped).toMatchObject({ reason: "not_connected" });

    outcome = ok([]);
    await host("watch-off").turnConfig();
    expect(await watchSchedules("watch-off")).toHaveLength(1);
    expect((await watchOf("watch-off"))?.stopped).toBeNull();
  });

  it("stops after an outdated runner answers three times, and Master's turn doesn't start it at once", async () => {
    roster({ "watch-old": "main" });
    runner(() => ({ ok: false, reason: "outdated" }));
    await host("watch-old").turnConfig();
    for (let check = 0; check < 3; check += 1) await host("watch-old").watchSessions();
    expect(await watchSchedules("watch-old")).toEqual([]);
    await host("watch-old").turnConfig();
    expect(await watchSchedules("watch-old")).toEqual([]);
    expect((await watchOf("watch-old"))?.stopped).toMatchObject({ reason: "outdated" });
  });

  it("stops once its agent isn't Master any more, without asking the runner", async () => {
    const roles = roster({ "watch-was": "main" });
    const asked = runner(() => ok([]));
    await host("watch-was").turnConfig();
    roles["watch-was"] = "specialist";
    await host("watch-was").watchSessions();
    expect(asked).toEqual([]);
    expect(await watchSchedules("watch-was")).toEqual([]);
  });
});
