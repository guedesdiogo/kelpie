import { describe, expect, it } from "vitest";
import type { SessionFile } from "../src/session-files.ts";
import type { SpoolEvent } from "../src/spool.ts";
import { ARCHIVE_IDLE_MS, lifeOf, WAIT_JOIN_MS } from "../src/waits.ts";
import { HOUR, MINUTE, NOW, SESSION_A, spoolEvent } from "./fake-vps.ts";

const T = NOW - 30 * MINUTE;

/** A live session whose file last changed at `T`. */
function file(overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    id: SESSION_A,
    pid: 4242,
    cwd: "/home/owner/Repos/kelpie",
    name: "A session",
    status: "busy",
    statusUpdatedAt: T,
    startedAt: T - HOUR,
    entrypoint: "claude-desktop",
    alive: true,
    waitingFor: "unknown",
    procStart: null,
    ...overrides,
  };
}

const at = (seconds: number) => T + seconds * 1_000;
const ev = (event: SpoolEvent["event"], seconds: number, extra: Partial<SpoolEvent> = {}) =>
  spoolEvent(event, at(seconds), extra);

describe("lifeOf", () => {
  it("is working, idle or unknown from the session file, with the time it last changed", () => {
    expect(lifeOf(file(), [], NOW)).toEqual({
      state: "working",
      since: T,
      wait: null,
      archivable: false,
    });
    expect(lifeOf(file({ status: "idle" }), [], NOW)).toMatchObject({ state: "idle", since: T });
    expect(lifeOf(file({ status: "unknown" }), [], NOW)).toMatchObject({ state: "unknown" });
  });

  it.each([
    ["a permission prompt", "permission", "waiting_permission", "permission"],
    ["needed input", "question", "waiting_answer", "question"],
    // A wait of unknown kind reads as one on an answer.
    ["something it doesn't know", "unknown", "waiting_answer", "question"],
  ] as const)(
    "opens a wait when the session file says it waits for %s, at the time it said so",
    (_, waitingFor, state, kind) => {
      const life = lifeOf(file({ status: "waiting", waitingFor }), [], NOW);
      expect(life).toEqual({ state, since: T, wait: { kind, openedAt: T }, archivable: false });
    },
  );

  it("opens no wait from a waiting file that doesn't say since when", () => {
    const life = lifeOf(file({ status: "waiting", statusUpdatedAt: null }), [], NOW);
    expect(life).toMatchObject({ state: "working", wait: null });
  });

  it("makes a file's wait and a hook's one wait: the earliest time, and the hook's kind", () => {
    const waiting = file({ status: "waiting", waitingFor: "permission", statusUpdatedAt: at(0) });
    const question = [ev("PermissionRequest", 1, { question: true })];
    expect(lifeOf(waiting, question, NOW).wait).toEqual({ kind: "question", openedAt: at(0) });
    const later = file({ status: "waiting", waitingFor: "question", statusUpdatedAt: at(2) });
    expect(lifeOf(later, [ev("PermissionRequest", 1)], NOW)).toMatchObject({
      state: "waiting_permission",
      since: at(1),
      wait: { kind: "permission", openedAt: at(1) },
    });
  });

  it("joins the file's wait to a hook's 6 s before, as for one prompt, up to 60 s apart", () => {
    const hook = [ev("PermissionRequest", 0, { question: true })];
    for (const seconds of [6, 60]) {
      const waiting = file({
        status: "waiting",
        waitingFor: "permission",
        statusUpdatedAt: at(seconds),
      });
      expect(lifeOf(waiting, hook, NOW).wait).toEqual({ kind: "question", openedAt: at(0) });
    }
    expect(WAIT_JOIN_MS).toBe(60_000);
  });

  it("takes a hook's request 120 s after an open one for the next prompt, the first's close lost", () => {
    const events = [ev("PermissionRequest", 0), ev("PermissionRequest", 120, { question: true })];
    // The file turned busy at 30 s, after the first prompt, before the second.
    const busy = file({ status: "busy", statusUpdatedAt: at(30) });
    expect(lifeOf(busy, events, NOW)).toMatchObject({
      state: "waiting_answer",
      since: at(120),
      wait: { kind: "question", openedAt: at(120) },
    });
    // The file busy before both.
    const before = file({ status: "busy", statusUpdatedAt: at(-10) });
    expect(lifeOf(before, events, NOW).wait).toEqual({ kind: "question", openedAt: at(120) });
    // The file waiting at 118 s, with the second request: one wait, from 118 s.
    const waiting = file({ status: "waiting", waitingFor: "permission", statusUpdatedAt: at(118) });
    expect(lifeOf(waiting, events, NOW).wait).toEqual({ kind: "question", openedAt: at(118) });
  });

  it("joins a hook's prompt 6 s after its request, and its next one within 60 s", () => {
    const events = [
      ev("PermissionRequest", 0, { question: true }),
      ev("Notification", 6, { type: "permission_prompt" }),
      ev("PermissionRequest", 60),
    ];
    expect(lifeOf(file(), events, NOW).wait).toEqual({ kind: "question", openedAt: at(0) });
  });

  it("takes a file's wait 120 s after a hook's for the next prompt, dropping the stale one", () => {
    const hook = [ev("PermissionRequest", 0, { question: true })];
    const waiting = file({ status: "waiting", waitingFor: "permission", statusUpdatedAt: at(120) });
    expect(lifeOf(waiting, hook, NOW)).toMatchObject({
      state: "waiting_permission",
      since: at(120),
      wait: { kind: "permission", openedAt: at(120) },
    });
    const justPast = file({ status: "waiting", statusUpdatedAt: at(60) + 1 });
    expect(lifeOf(justPast, hook, NOW).wait?.openedAt).toBe(at(60) + 1);
  });

  it("sees the next prompt after waiting, busy and waiting again, though the hooks' close was lost", () => {
    // The hook's wait opened at 0; the file went busy at 30, unseen, and waits again since 90.
    const events = [ev("PermissionRequest", 0)];
    const again = file({ status: "waiting", waitingFor: "question", statusUpdatedAt: at(90) });
    expect(lifeOf(again, events, NOW).wait).toEqual({ kind: "question", openedAt: at(90) });
  });

  it("keeps a hook's wait over a file's `waiting` more than 60 s older, the stale one then", () => {
    const waiting = file({ status: "waiting", waitingFor: "question", statusUpdatedAt: at(0) });
    const events = [ev("PermissionRequest", 120)];
    expect(lifeOf(waiting, events, NOW).wait).toEqual({ kind: "permission", openedAt: at(120) });
  });

  it.each([
    "UserPromptSubmit",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "SessionEnd",
  ] as const)("closes a file's wait on a %s after it opened, not on one before", (event) => {
    const waiting = file({ status: "waiting", statusUpdatedAt: at(5) });
    const after = [ev(event, 6, { reason: "clear" })];
    expect(lifeOf(waiting, after, NOW)).toMatchObject({ state: "working", wait: null });
    const before = [ev(event, 4, { reason: "clear" })];
    expect(lifeOf(waiting, before, NOW).wait).toEqual({ kind: "question", openedAt: at(5) });
  });

  it("keeps a file's wait through an event that closes nothing, and drops it once the session ends", () => {
    const waiting = file({ status: "waiting", waitingFor: "permission", statusUpdatedAt: at(5) });
    const notified = [ev("Notification", 11, { type: "permission_prompt" })];
    expect(lifeOf(waiting, notified, NOW).wait).toEqual({ kind: "permission", openedAt: at(5) });
    expect(lifeOf({ ...waiting, alive: false }, [], NOW)).toMatchObject({
      state: "ended",
      wait: null,
    });
    const ended = [ev("SessionEnd", 6, { reason: "other" })];
    expect(lifeOf(waiting, ended, NOW)).toMatchObject({ state: "ended", wait: null });
  });

  it.each([
    ["a permission request", [ev("PermissionRequest", 1)], "waiting_permission"],
    [
      "AskUserQuestion's request",
      [ev("PermissionRequest", 1, { question: true })],
      "waiting_answer",
    ],
    [
      "a permission prompt",
      [ev("Notification", 1, { type: "permission_prompt" })],
      "waiting_permission",
    ],
    ["an elicitation", [ev("Notification", 1, { type: "elicitation_dialog" })], "waiting_answer"],
  ])("opens a wait on %s", (_, events, state) => {
    const life = lifeOf(file(), events, NOW);
    expect(life).toMatchObject({ state, since: at(1), archivable: false });
    expect(life.wait?.openedAt).toBe(at(1));
  });

  it("opens no wait on another notification", () => {
    for (const type of ["idle_prompt", "auth_success", undefined]) {
      const events = [ev("Notification", 1, type === undefined ? {} : { type })];
      expect(lifeOf(file(), events, NOW).wait).toBeNull();
    }
  });

  it("joins the prompt that follows a request to its wait: one wait, its first time and kind", () => {
    const events = [
      ev("PermissionRequest", 1, { question: true }),
      ev("Notification", 7, { type: "permission_prompt" }),
      ev("Notification", 8, { type: "elicitation_dialog" }),
      ev("PermissionRequest", 9),
    ];
    expect(lifeOf(file(), events, NOW)).toMatchObject({
      state: "waiting_answer",
      since: at(1),
      wait: { kind: "question", openedAt: at(1) },
    });
  });

  it.each([
    "UserPromptSubmit",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "SessionEnd",
  ] as const)("closes a wait on the session's next %s", (event) => {
    const events = [ev("PermissionRequest", 1), ev(event, 2, { reason: "clear" })];
    expect(lifeOf(file(), events, NOW).wait).toBeNull();
  });

  it("opens a new wait after one closed", () => {
    const events = [ev("PermissionRequest", 1), ev("PostToolUse", 2), ev("PermissionRequest", 3)];
    expect(lifeOf(file(), events, NOW).wait).toEqual({ kind: "permission", openedAt: at(3) });
  });

  it("orders events by their time, as hooks may write them out of order", () => {
    const events = [ev("PostToolUse", 2), ev("PermissionRequest", 1)];
    expect(lifeOf(file(), events, NOW).wait).toBeNull();
    expect(lifeOf(file(), [...events].reverse(), NOW).wait).toBeNull();
    const reopened = [ev("PermissionRequest", 3), ev("PostToolUse", 2)];
    expect(lifeOf(file(), reopened, NOW).wait?.openedAt).toBe(at(3));
  });

  it.each(["idle", "busy"] as const)(
    "closes a wait when the session file turns %s after it opened, as after an answer in the app",
    (status) => {
      const events = [ev("PermissionRequest", 1)];
      expect(lifeOf(file({ status, statusUpdatedAt: at(5) }), events, NOW).wait).toBeNull();
    },
  );

  it("keeps a wait open against the status its file held when it opened, `waiting`, or none", () => {
    const events = [ev("PermissionRequest", 1)];
    for (const changed of [file({ statusUpdatedAt: at(0) }), file({ statusUpdatedAt: at(1) })]) {
      expect(lifeOf(changed, events, NOW).state).toBe("waiting_permission");
    }
    // A file that turns `waiting` later joins the hook's wait.
    const waiting = file({ status: "waiting", statusUpdatedAt: at(7) });
    expect(lifeOf(waiting, events, NOW).wait).toEqual({ kind: "permission", openedAt: at(1) });
    const unknown = file({ status: "unknown", statusUpdatedAt: at(7) });
    expect(lifeOf(unknown, events, NOW).state).toBe("waiting_permission");
    const unsaid = file({ status: "idle", statusUpdatedAt: null });
    expect(lifeOf(unsaid, events, NOW).state).toBe("waiting_permission");
  });

  it("has ended when its process is gone, since its last sign of life, and could be archived", () => {
    expect(lifeOf(file({ alive: false }), [], NOW)).toEqual({
      state: "ended",
      since: T,
      wait: null,
      archivable: true,
    });
    const events = [ev("PermissionRequest", 60)];
    expect(lifeOf(file({ alive: false }), events, NOW)).toMatchObject({
      state: "ended",
      since: at(60),
      wait: null,
    });
    expect(lifeOf(file({ alive: false, statusUpdatedAt: at(90) }), events, NOW).since).toBe(at(90));
    expect(lifeOf(file({ alive: false, statusUpdatedAt: null }), events, NOW).since).toBe(at(60));
    expect(lifeOf(file({ alive: false, statusUpdatedAt: null }), [], NOW).since).toBeNull();
  });

  it.each(["other", "logout", "prompt_input_exit", undefined])(
    "has ended after a SessionEnd whose reason is %s",
    (reason) => {
      const end = ev("SessionEnd", 10, reason === undefined ? {} : { reason });
      expect(lifeOf(file(), [ev("PermissionRequest", 1), end], NOW)).toEqual({
        state: "ended",
        since: at(10),
        wait: null,
        archivable: true,
      });
    },
  );

  it("comes back when a new process took the session after its end, as after a reboot", () => {
    const end = [ev("SessionEnd", 0, { reason: "other" })];
    const restarted = file({ startedAt: at(10), status: "idle", statusUpdatedAt: at(20) });
    expect(lifeOf(restarted, end, NOW)).toMatchObject({ state: "idle", since: at(20) });
    // Still ended: the same process, a process gone, or one whose start isn't known.
    expect(lifeOf(file({ startedAt: at(-10) }), end, NOW).state).toBe("ended");
    expect(lifeOf(file({ startedAt: at(0) }), end, NOW).state).toBe("ended");
    expect(lifeOf({ ...restarted, alive: false }, end, NOW).state).toBe("ended");
    expect(lifeOf({ ...restarted, alive: null }, end, NOW).state).toBe("ended");
    expect(lifeOf({ ...restarted, startedAt: null }, end, NOW).state).toBe("ended");
  });

  it.each(["clear", "resume"])("hasn't ended after a SessionEnd for %s", (reason) => {
    expect(lifeOf(file(), [ev("SessionEnd", 10, { reason })], NOW).state).toBe("working");
  });

  it("comes back with a later event from a live process", () => {
    const events = [ev("SessionEnd", 10, { reason: "other" }), ev("UserPromptSubmit", 20)];
    expect(lifeOf(file(), events, NOW).state).toBe("working");
    const waiting = [...events, ev("PermissionRequest", 30)];
    expect(lifeOf(file(), waiting, NOW).state).toBe("waiting_permission");
    expect(lifeOf(file({ alive: false }), waiting, NOW).state).toBe("ended");
  });

  it("takes a session without a pid for alive, unless a SessionEnd says otherwise", () => {
    expect(lifeOf(file({ alive: null }), [], NOW).state).toBe("working");
  });

  it("could archive a session idle for 3 hours or more, not one idle for less", () => {
    const idle = (since: number | null) => file({ status: "idle", statusUpdatedAt: since });
    expect(lifeOf(idle(NOW - ARCHIVE_IDLE_MS), [], NOW).archivable).toBe(true);
    expect(lifeOf(idle(NOW - ARCHIVE_IDLE_MS + 1), [], NOW).archivable).toBe(false);
    expect(lifeOf(idle(null), [], NOW)).toMatchObject({
      state: "idle",
      since: null,
      archivable: false,
    });
    expect(ARCHIVE_IDLE_MS).toBe(3 * HOUR);
  });
});

describe("lifeOf, with a session's subagents (#482)", () => {
  // Two subagents' ids, as Claude Code's `agent_id` gives them.
  const REVIEWER = "a1b2c3d4e5f6a7b8";
  const EXPLORER = "a9f8e7d6c5b4a3b2";
  const by = (agent: string | null) => ({ agent });
  const CLOSING = [
    "UserPromptSubmit",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
  ] as const;

  it("keeps the main thread's question open across a subagent's tool calls, and closes it on the main thread's", () => {
    // #470's live check: a review subagent's PostToolUse, 40 s after the question, closed it.
    const asked = [
      ev("PermissionRequest", 0, { question: true }),
      ev("PostToolUse", 40, by(REVIEWER)),
      ev("PostToolUseFailure", 50, by(REVIEWER)),
    ];
    expect(lifeOf(file(), asked, NOW)).toMatchObject({
      state: "waiting_answer",
      since: at(0),
      wait: { kind: "question", openedAt: at(0) },
    });
    expect(lifeOf(file(), [...asked, ev("PostToolUse", 3_600)], NOW).wait).toBeNull();
  });

  it.each(CLOSING)(
    "keeps the main thread's wait open on a subagent's %s, its id known or not",
    (event) => {
      for (const agent of [REVIEWER, null]) {
        const events = [ev("PermissionRequest", 0, { question: true }), ev(event, 1, by(agent))];
        expect(lifeOf(file(), events, NOW).wait).toEqual({ kind: "question", openedAt: at(0) });
      }
    },
  );

  it("keeps a file's wait open on a subagent's events, and closes it on the main thread's", () => {
    const waiting = file({ status: "waiting", waitingFor: "question", statusUpdatedAt: at(5) });
    const subagents = [ev("PostToolUse", 6, by(REVIEWER)), ev("PostToolUseFailure", 7, by(null))];
    expect(lifeOf(waiting, subagents, NOW).wait).toEqual({ kind: "question", openedAt: at(5) });
    expect(lifeOf(waiting, [...subagents, ev("PostToolUse", 8)], NOW).wait).toBeNull();
  });

  it.each([
    ["a permission request", "PermissionRequest", {}, "waiting_permission", "permission"],
    [
      "AskUserQuestion's request",
      "PermissionRequest",
      { question: true },
      "waiting_answer",
      "question",
    ],
    [
      "a permission prompt",
      "Notification",
      { type: "permission_prompt" },
      "waiting_permission",
      "permission",
    ],
    [
      "an elicitation",
      "Notification",
      { type: "elicitation_dialog" },
      "waiting_answer",
      "question",
    ],
  ] as const)(
    "opens a wait on a subagent's own %s, its id known or not",
    (_, event, extra, state, kind) => {
      for (const agent of [REVIEWER, null]) {
        // A wait of its own: the main thread's tool calls go on, and leave it open.
        const events = [ev(event, 1, { ...extra, agent }), ev("PostToolUse", 2)];
        expect(lifeOf(file(), events, NOW)).toEqual({
          state,
          since: at(1),
          wait: { kind, openedAt: at(1) },
          archivable: false,
        });
      }
    },
  );

  it.each(CLOSING)(
    "closes a subagent's wait on its own %s, not on another subagent's or the main thread's events",
    (event) => {
      const asked = [ev("PermissionRequest", 0, by(REVIEWER))];
      const others = [
        ev("PostToolUse", 10, by(EXPLORER)),
        ev("PostToolUseFailure", 11, by(null)),
        ev("UserPromptSubmit", 12),
        ev("PostToolUse", 13),
        ev("Stop", 14),
      ];
      expect(lifeOf(file(), [...asked, ...others], NOW).wait).toEqual({
        kind: "permission",
        openedAt: at(0),
      });
      const own = ev(event, 20, by(REVIEWER));
      expect(lifeOf(file(), [...asked, ...others, own], NOW)).toMatchObject({
        state: "working",
        wait: null,
      });
    },
  );

  it("takes the subagents of unknown id for one: any of their events closes their wait", () => {
    const asked = ev("Notification", 0, { type: "permission_prompt", agent: null });
    expect(lifeOf(file(), [asked, ev("PostToolUse", 5, by(REVIEWER))], NOW).wait).toEqual({
      kind: "permission",
      openedAt: at(0),
    });
    expect(lifeOf(file(), [asked, ev("PostToolUse", 5, by(null))], NOW).wait).toBeNull();
  });

  it.each(["clear", "resume"])(
    "closes every thread's wait on the session's SessionEnd (%s)",
    (reason) => {
      const events = [
        ev("PermissionRequest", 0, { question: true }),
        ev("PermissionRequest", 1, by(REVIEWER)),
        ev("Notification", 2, { type: "elicitation_dialog", agent: null }),
        ev("PostToolUse", 3),
      ];
      // The main thread's answer leaves the subagents' waits open; the session's end closes them.
      expect(lifeOf(file(), events, NOW).wait).toEqual({ kind: "question", openedAt: at(2) });
      const ended = [...events, ev("SessionEnd", 4, { reason })];
      expect(lifeOf(file(), ended, NOW)).toMatchObject({ state: "working", wait: null });
    },
  );

  it.each(["idle", "busy"] as const)(
    "leaves a subagent's wait open when the session file turns %s, which closes the main thread's",
    (status) => {
      const turned = file({ status, statusUpdatedAt: at(5) });
      expect(lifeOf(turned, [ev("PermissionRequest", 1)], NOW).wait).toBeNull();
      expect(lifeOf(turned, [ev("PermissionRequest", 1, by(REVIEWER))], NOW)).toMatchObject({
        state: "waiting_permission",
        since: at(1),
        wait: { kind: "permission", openedAt: at(1) },
      });
    },
  );

  it("joins a subagent's prompts within 60 s, and takes a later one for its next, in its own thread", () => {
    // The main thread's tool call between the two neither closes the wait nor stops the join.
    const joined = [
      ev("PermissionRequest", 0, { question: true, agent: REVIEWER }),
      ev("PostToolUse", 3),
      ev("Notification", 6, { type: "permission_prompt", agent: REVIEWER }),
    ];
    expect(lifeOf(file(), joined, NOW).wait).toEqual({ kind: "question", openedAt: at(0) });
    expect(lifeOf(file(), [...joined, ev("PostToolUse", 10, by(REVIEWER))], NOW).wait).toBeNull();
    // Its request 120 s later is its next prompt: the first, whose close was lost, is dropped.
    const next = [
      ev("PermissionRequest", 0, by(REVIEWER)),
      ev("PermissionRequest", 120, { question: true, agent: REVIEWER }),
    ];
    expect(lifeOf(file(), next, NOW).wait).toEqual({ kind: "question", openedAt: at(120) });
    expect(lifeOf(file(), [...next, ev("PostToolUse", 130, by(REVIEWER))], NOW).wait).toBeNull();
  });

  it("keeps each thread's wait apart, and shows the latest opened of those still open", () => {
    // The main thread's question, then a subagent's prompt 10 s later: two waits, not one.
    const both = [
      ev("PermissionRequest", 0, { question: true }),
      ev("PermissionRequest", 10, by(REVIEWER)),
    ];
    expect(lifeOf(file(), both, NOW)).toMatchObject({
      state: "waiting_permission",
      since: at(10),
      wait: { kind: "permission", openedAt: at(10) },
    });
    const answered = [...both, ev("PostToolUse", 20, by(REVIEWER))];
    expect(lifeOf(file(), answered, NOW)).toMatchObject({
      state: "waiting_answer",
      since: at(0),
      wait: { kind: "question", openedAt: at(0) },
    });
    expect(lifeOf(file(), [...answered, ev("PostToolUse", 30)], NOW).wait).toBeNull();
    // A subagent's wait whose close never came hides no later prompt of another thread.
    const stale = [
      ev("PermissionRequest", 0, by(EXPLORER)),
      ev("PermissionRequest", 600, { question: true }),
    ];
    expect(lifeOf(file(), stale, NOW).wait).toEqual({ kind: "question", openedAt: at(600) });
    expect(lifeOf(file(), [...stale, ev("PostToolUse", 700)], NOW).wait).toEqual({
      kind: "permission",
      openedAt: at(0),
    });
  });

  it("shows the latest opened wait, whichever thread's came first", () => {
    // The file's wait, the main thread's, at 5 s; a subagent's question at 10 s, the later.
    const waiting = file({ status: "waiting", waitingFor: "permission", statusUpdatedAt: at(5) });
    const asked = [ev("PermissionRequest", 10, { question: true, agent: REVIEWER })];
    expect(lifeOf(waiting, asked, NOW)).toMatchObject({
      state: "waiting_answer",
      since: at(10),
      wait: { kind: "question", openedAt: at(10) },
    });
    // The main thread's next prompt, 120 s after its first, is later than the subagent's.
    const next = [
      ev("PermissionRequest", 0),
      ev("PermissionRequest", 10, { question: true, agent: REVIEWER }),
      ev("PermissionRequest", 120),
    ];
    expect(lifeOf(file(), next, NOW).wait).toEqual({ kind: "permission", openedAt: at(120) });
    const answered = [...next, ev("PostToolUse", 130, by(REVIEWER))];
    expect(lifeOf(file(), answered, NOW).wait).toEqual({ kind: "permission", openedAt: at(120) });
  });

  it("joins the session file's wait to the main thread's hook wait, never to a subagent's", () => {
    const waiting = file({ status: "waiting", waitingFor: "permission", statusUpdatedAt: at(5) });
    const subagent = [ev("PermissionRequest", 0, { question: true, agent: REVIEWER })];
    // Two waits: the subagent's, and the file's, the main thread's, which is the later.
    expect(lifeOf(waiting, subagent, NOW).wait).toEqual({ kind: "permission", openedAt: at(5) });
    const answered = [...subagent, ev("PostToolUse", 6, by(REVIEWER))];
    expect(lifeOf(waiting, answered, NOW).wait).toEqual({ kind: "permission", openedAt: at(5) });
    const main = [ev("PermissionRequest", 0, { question: true })];
    expect(lifeOf(waiting, main, NOW).wait).toEqual({ kind: "question", openedAt: at(0) });
  });

  it("reads a spool line from before #482, with no subagent's mark, as the main thread's", () => {
    // An old line's question, then the new hook's lines: a subagent's, then the main thread's.
    const old: SpoolEvent = {
      at: at(0),
      event: "PermissionRequest",
      session: SESSION_A,
      question: true,
    };
    const events = [old, ev("PostToolUse", 40, by(REVIEWER))];
    expect(lifeOf(file(), events, NOW).wait).toEqual({ kind: "question", openedAt: at(0) });
    expect(lifeOf(file(), [...events, ev("PostToolUse", 50)], NOW).wait).toBeNull();
  });
});
