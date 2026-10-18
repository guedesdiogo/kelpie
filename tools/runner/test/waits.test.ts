import { describe, expect, it } from "vitest";
import type { SessionFile } from "../src/session-files.ts";
import type { SpoolEvent } from "../src/spool.ts";
import { ARCHIVE_IDLE_MS, lifeOf } from "../src/waits.ts";
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
