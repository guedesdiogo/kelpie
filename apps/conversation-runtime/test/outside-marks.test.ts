import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { OUTSIDE_WINDOW_MS } from "../src/outside-content.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import { fakeWorld, reply } from "./fakes.ts";

// Which turns are marked as having read outside content (ADR-0064), as the records work it out for
// a whole session in one pass, and a turn's start for itself: the same rules, by earlier turns and
// their times, whatever the range.

const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
const MINUTE = 60_000;

/** A conversation with one turn delivered, so its tables and its destination exist. */
async function conversation(name: string) {
  const world = fakeWorld([reply("Oi.")]);
  replacePortsForTesting(world.ports);
  const stub = agent(name);
  await stub.ingest({
    agentId: "assistant",
    providerMessageId: `${name}:m0`,
    userId: "u-owner",
    role: "owner",
    chatType: "direct",
    text: "oi",
    destination: { channel: "telegram", threadId: name },
    sentAt: Date.UTC(2026, 9, 21, 12),
    timeZone: null,
  });
  await stub.flush();
  await vi.waitFor(async () => expect((await stub.turns()).at(-1)?.status).toBe("delivered"));
  return { stub, world };
}

/** A small, seeded generator, so a failing case is the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Sql = DurableObjectState["storage"]["sql"];

/**
 * Turns of every kind, written straight to the tables: reads, turns in the window or past it,
 * Kelpie's notes, rows that come back later than their turn, checkpoints, and held changes open,
 * used and expired, among the confirmations of other commands.
 */
function generate(sql: Sql, seed: number, turns: number) {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  let clock = Date.UTC(2026, 9, 21, 13);
  let checkpoint: number | null = null;
  const maxHistory = () => (sql.exec("SELECT max(id) AS id FROM history").one().id as number) ?? 0;
  for (let index = 0; index < turns; index += 1) {
    clock += pick([0, 1, 4, 9, 11, 30]) * MINUTE + Math.floor(next() * 50_000);
    if (next() < 0.08) {
      sql.exec(
        "INSERT INTO checkpoints (summary, kept_from_history_id, created_at) VALUES ('s', ?, ?)",
        Math.max(1, Math.floor(next() * (maxHistory() + 2))),
        clock,
      );
      checkpoint = sql.exec("SELECT max(id) AS id FROM checkpoints").one().id as number;
    }
    sql.exec(
      "INSERT INTO turns (generation, status, attempts, system_version, checkpoint_id, outside, created_at) VALUES (0, 'delivered', 1, 1, ?, ?, ?)",
      checkpoint,
      next() < 0.15 ? 1 : 0,
      clock,
    );
    const id = sql.exec("SELECT max(id) AS id FROM turns").one().id as number;
    const users = next() < 0.2 ? 2 : 1;
    for (let user = 0; user < users; user += 1) {
      sql.exec(
        "INSERT INTO history (turn_id, role, user_id, system_version, message, from_kelpie, created_at) VALUES (?, 'user', 'u-owner', 1, '{}', ?, ?)",
        id,
        next() < 0.3 ? 1 : 0,
        clock,
      );
    }
    for (let row = Math.floor(next() * 4); row > 0; row -= 1) {
      sql.exec(
        "INSERT INTO history (turn_id, role, system_version, message, from_kelpie, created_at) VALUES (?, ?, 1, '{}', 0, ?)",
        id,
        pick(["assistant", "tool"]),
        clock + Math.floor(next() * 12 * MINUTE),
      );
    }
    if (next() < 0.25) {
      const used = next();
      sql.exec(
        "INSERT INTO confirmations (code, user_id, command, input, summary, after_history_id, turn_id, created_at, expires_at, used_at) VALUES ('ABCDEF', 'u-owner', ?, '{}', 's', ?, ?, ?, ?, ?)",
        next() < 0.25 ? "configureAgent" : "tool:memory_write",
        maxHistory() - Math.floor(next() * 3),
        id,
        clock,
        clock + Math.floor((next() * 20 - 5) * MINUTE),
        used < 0.5 ? null : clock + Math.floor((used * 16 - 4) * MINUTE),
      );
    }
  }
}

/**
 * The rules one query at a time, as ADR-0064 states them: the reference the one pass must match.
 * Each turn's answer comes with the rule that marked it.
 */
function reference(sql: Sql, task: boolean): { id: number; marked: boolean; by: string }[] {
  const one = (query: string, ...values: unknown[]) =>
    sql.exec(query, ...values).toArray().length > 0;
  const turns = sql
    .exec<{ id: number; checkpoint_id: number | null; outside: number; created_at: number }>(
      "SELECT id, checkpoint_id, outside, created_at FROM turns ORDER BY id",
    )
    .toArray();
  return turns.map(({ id, checkpoint_id: checkpointId, outside, created_at: start }) => {
    const answer = (marked: boolean, by: string) => ({ id, marked, by });
    if (outside === 1) return answer(true, "read");
    const since = start - OUTSIDE_WINDOW_MS;
    if (
      one(
        "SELECT 1 FROM turns WHERE outside = 1 AND id < ? AND created_at > ? LIMIT 1",
        id,
        since,
      ) ||
      one(
        "SELECT 1 FROM history h JOIN turns t ON t.id = h.turn_id WHERE t.outside = 1 AND t.id < ? AND h.created_at > ? LIMIT 1",
        id,
        since,
      )
    ) {
      return answer(true, "window");
    }
    const first =
      (sql.exec("SELECT min(id) AS id FROM history WHERE turn_id = ?", id).one().id as number) ?? 0;
    if (
      one(
        "SELECT 1 FROM confirmations WHERE command LIKE 'tool:%' AND after_history_id < ? AND expires_at > ? AND (used_at IS NULL OR used_at >= ?) LIMIT 1",
        first,
        start,
        start,
      )
    ) {
      return answer(true, "held");
    }
    const typed = one(
      "SELECT 1 FROM history WHERE turn_id = ? AND role = 'user' AND from_kelpie = 0 LIMIT 1",
      id,
    );
    if (!task && typed) return answer(false, "person");
    const kept =
      checkpointId === null
        ? 0
        : ((sql
            .exec("SELECT kept_from_history_id AS id FROM checkpoints WHERE id = ?", checkpointId)
            .one().id as number) ?? 0);
    return one(
      "SELECT 1 FROM history h JOIN turns t ON t.id = h.turn_id WHERE h.id >= ? AND t.outside = 1 AND t.id < ? LIMIT 1",
      kept,
      id,
    )
      ? answer(true, "history")
      : answer(false, task ? "task" : "note");
  });
}

afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("the marks in one pass (ADR-0064)", () => {
  it("match the rules one turn at a time, over generated conversations", async () => {
    const reasons = new Set<string>();
    for (const [seed, task] of [
      [1, false],
      [2, false],
      [3, false],
      [4, true],
      [5, false],
      [6, true],
    ] as const) {
      const { stub } = await conversation(`marks-${seed}`);
      const expected = await runInDurableObject(stub, (_instance: ConversationAgent, state) => {
        if (task) {
          state.storage.sql.exec(
            "UPDATE state SET value = ? WHERE key = 'destination'",
            JSON.stringify({ channel: "task", threadId: "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f" }),
          );
        }
        generate(state.storage.sql, seed, 60);
        return reference(state.storage.sql, task);
      });
      for (const { by } of expected) reasons.add(by);
      const marks = expected.map(({ id, marked }) => ({ id, marked }));
      // The records' one pass over every turn, and each turn's own, as its start works it out.
      expect(await stub.outsideMarks(), `seed ${seed}`).toEqual(marks);
      expect(await stub.outsideMarks(true), `seed ${seed}`).toEqual(marks);
    }
    // Every rule marked some turn, and both kinds of turn went unmarked.
    expect([...reasons].sort()).toEqual(
      ["held", "history", "note", "person", "read", "task", "window"].sort(),
    );
  });

  it("keep a long session's close quick", async () => {
    const { stub, world } = await conversation("marks-cost");
    await runInDurableObject(stub, (_instance: ConversationAgent, state) => {
      const sql = state.storage.sql;
      const big = "x".repeat(2_000);
      let clock = Date.UTC(2026, 9, 21, 13);
      for (let index = 0; index < 1_000; index += 1) {
        clock += MINUTE;
        sql.exec(
          "INSERT INTO turns (generation, status, attempts, system_version, outside, created_at) VALUES (0, 'delivered', 1, 1, ?, ?)",
          index === 5 ? 1 : 0,
          clock,
        );
        const id = sql.exec("SELECT max(id) AS id FROM turns").one().id as number;
        sql.exec(
          "INSERT INTO history (turn_id, role, user_id, system_version, message, from_kelpie, created_at) VALUES (?, 'user', 'u-owner', 1, ?, 0, ?)",
          id,
          JSON.stringify({ role: "user", parts: [{ type: "text", text: `q${index}` }] }),
          clock,
        );
        for (let row = 1; row < 6; row += 1) {
          const message =
            row === 5
              ? { role: "assistant", parts: [{ type: "text", text: `answer ${index}.` }] }
              : { role: "tool", results: [{ callId: "c", output: big }] };
          sql.exec(
            "INSERT INTO history (turn_id, role, system_version, message, from_kelpie, created_at) VALUES (?, ?, 1, ?, 0, ?)",
            id,
            message.role,
            JSON.stringify(message),
            clock + row,
          );
        }
      }
    });
    const started = performance.now();
    await stub.closeSession();
    const took = performance.now() - started;
    // Kelpie's line in place of the replies the read marked, and the rest kept.
    const page = world.remembered.at(-1)?.changes[0]?.content ?? "";
    // The read is the sixth turn: its reply and those of the next 10 minutes go.
    expect(page).not.toContain("answer 5.");
    expect(page).not.toContain("answer 15.");
    expect(page).toContain("answer 16.");
    expect(page).toContain("answer 999.");
    // One pass over 6,000 rows takes about 130 ms here; a query per turn took over 20 s.
    expect(took).toBeLessThan(2_000);
  }, 60_000);
});
