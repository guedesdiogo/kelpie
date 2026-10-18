import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseRunnerVpsSessions,
  parseRunnerVpsWaits,
  type RunnerVpsSessions,
  type RunnerVpsWaits,
} from "../../../packages/channels/src/runner.ts";
import {
  MAX_EXCERPT_CHARS,
  MAX_SESSIONS_BYTES,
  MAX_TITLE_CHARS,
  MAX_VPS_SESSIONS,
  MAX_WAITS_BYTES,
} from "../src/protocol.ts";
import { REDACTED } from "../src/redact.ts";
import { ownUid } from "../src/secrets.ts";
import { prepareSpoolDir, readExcerpt, writeExcerpt } from "../src/spool.ts";
import {
  EXCERPT_RETENTION_MS,
  VpsSessions,
  type VpsSessionsOptions,
  withinBytes,
} from "../src/vps-sessions.ts";
import { ARCHIVE_IDLE_MS } from "../src/waits.ts";
import {
  type FakeVps,
  fakeVps,
  HOUR,
  MINUTE,
  makeCheckout,
  makeWorktree,
  NOW,
  prLink,
  RUNNER_SECRET,
  SESSION_A,
  SESSION_B,
  SESSION_C,
  sessionFields,
  spoolEvent,
  writeEvents,
  writeSessionFile,
  writeTranscript,
} from "./fake-vps.ts";

const PR = "https://github.com/guedesdiogo/kelpie/pull/433";

let vps: FakeVps;
let main: string;
let worktree: string;
beforeEach(() => {
  vps = fakeVps();
  main = join(vps.repos, "kelpie");
  makeCheckout(main, "main");
  worktree = join(main, ".claude", "worktrees", "runner");
  makeWorktree(main, worktree, "feat/runner-vps-sessions");
});
afterEach(() => vps.cleanup());

function service(overrides: Partial<VpsSessionsOptions> = {}) {
  const warnings: string[] = [];
  const sessions = new VpsSessions({
    claudeDir: vps.claudeDir,
    spoolDir: vps.spoolDir,
    workDir: vps.workDir,
    holds: () => false,
    secrets: [RUNNER_SECRET],
    warn: (message) => warnings.push(message),
    now: () => NOW,
    alive: (pid) => pid < 9_000,
    uid: ownUid(),
    ...overrides,
  });
  return { sessions, warnings };
}

/** The answer as it goes out, and as channel-egress checks it. */
function listed(sessions: VpsSessions): RunnerVpsSessions {
  const answer = sessions.list();
  expect(parseRunnerVpsSessions(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  return answer;
}

function waited(sessions: VpsSessions, since: number): RunnerVpsWaits {
  const answer = sessions.waits(since);
  expect(parseRunnerVpsWaits(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  return answer;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("VpsSessions.list", () => {
  it("lists a session with its state, its age, its checkout, its title, its PR and its excerpt", () => {
    writeSessionFile(vps, sessionFields({ pid: 101, cwd: worktree, status: "idle" }));
    writeTranscript(vps, SESSION_A, worktree, [prLink(PR)]);
    writeEvents(vps, [spoolEvent("Stop", NOW - 10 * MINUTE)]);
    writeExcerpt(vps.spoolDir, SESSION_A, { at: NOW - 10 * MINUTE, text: "Opened the PR." });
    expect(listed(service().sessions)).toEqual({
      ok: true,
      now: NOW,
      truncated: false,
      sessions: [
        {
          id: SESSION_A,
          state: "idle",
          since: NOW - 10 * MINUTE,
          archivable: false,
          status: "idle",
          statusUpdatedAt: NOW - 10 * MINUTE,
          startedAt: NOW - 5 * HOUR,
          alive: true,
          startedBy: "app",
          entrypoint: "claude-desktop",
          title: "Review the runner's sessions",
          repository: "kelpie",
          branch: "feat/runner-vps-sessions",
          prUrl: PR,
          excerpt: "Opened the PR.",
        },
      ],
    });
  });

  it("tells the app, a terminal and anything else apart, and lists the most recent first", () => {
    writeSessionFile(vps, sessionFields({ pid: 101, statusUpdatedAt: NOW - 3 * MINUTE }));
    writeSessionFile(
      vps,
      sessionFields({
        pid: 102,
        sessionId: SESSION_B,
        entrypoint: "cli",
        statusUpdatedAt: NOW - MINUTE,
      }),
    );
    writeSessionFile(
      vps,
      sessionFields({
        pid: 103,
        sessionId: SESSION_C,
        entrypoint: "sdk-cli",
        statusUpdatedAt: NOW - 2 * MINUTE,
      }),
    );
    writeSessionFile(
      vps,
      sessionFields({
        pid: 104,
        sessionId: "dddddddd-1111-4222-8333-444444444444",
        entrypoint: undefined,
        statusUpdatedAt: undefined,
      }),
    );
    writeSessionFile(
      vps,
      sessionFields({
        pid: 105,
        sessionId: "eeeeeeee-1111-4222-8333-444444444444",
        entrypoint: "constructor",
        statusUpdatedAt: undefined,
      }),
    );
    const { sessions } = listed(service().sessions);
    expect(sessions.map(({ id, startedBy }) => [id.slice(0, 1), startedBy])).toEqual([
      ["b", "terminal"],
      ["c", "unknown"],
      ["a", "app"],
      ["d", "unknown"],
      ["e", "unknown"],
    ]);
  });

  it("leaves out the runner's own sessions: in its work folder, or held by their id", () => {
    writeSessionFile(vps, sessionFields({ pid: 101, cwd: vps.workDir }));
    writeSessionFile(
      vps,
      sessionFields({ pid: 102, sessionId: SESSION_B, cwd: join(vps.workDir, "sub") }),
    );
    writeSessionFile(vps, sessionFields({ pid: 103, sessionId: SESSION_C, cwd: null }));
    writeSessionFile(
      vps,
      sessionFields({
        pid: 104,
        sessionId: "dddddddd-1111-4222-8333-444444444444",
        cwd: `${vps.workDir}-other`,
      }),
    );
    const holds = (id: string) => id === SESSION_C;
    const { sessions } = listed(service({ holds }).sessions);
    expect(sessions.map((session) => session.id)).toEqual(["dddddddd-1111-4222-8333-444444444444"]);
  });

  it("derives the waits and the endings from the hooks' events, and marks what could be archived", () => {
    writeSessionFile(vps, sessionFields({ pid: 101 }));
    writeSessionFile(
      vps,
      sessionFields({
        pid: 102,
        sessionId: SESSION_B,
        status: "idle",
        statusUpdatedAt: NOW - ARCHIVE_IDLE_MS,
      }),
    );
    writeSessionFile(vps, sessionFields({ pid: 9_103, sessionId: SESSION_C }));
    // A terminal's sessions can't be archived in the app: they show only as ended, or idle.
    const terminal = (pid: number, id: string, status: string) =>
      sessionFields({
        pid,
        sessionId: id,
        entrypoint: "cli",
        status,
        statusUpdatedAt: NOW - 4 * HOUR,
      });
    writeSessionFile(vps, terminal(9_104, "dddddddd-1111-4222-8333-444444444444", "busy"));
    writeSessionFile(vps, terminal(105, "eeeeeeee-1111-4222-8333-444444444444", "idle"));
    writeEvents(vps, [
      spoolEvent("PermissionRequest", NOW - MINUTE, { question: true }),
      spoolEvent("Notification", NOW - 50_000, { type: "permission_prompt" }),
    ]);
    const { sessions } = listed(service().sessions);
    expect(
      sessions.map(({ id, state, archivable }) => [id.slice(0, 1), state, archivable]),
    ).toEqual([
      ["a", "waiting_answer", false],
      ["c", "ended", true],
      ["b", "idle", true],
      ["d", "ended", false],
      ["e", "idle", false],
    ]);
  });

  it("redacts every text again on the way out, the runner's secret by value first", () => {
    writeSessionFile(vps, sessionFields({ pid: 101, cwd: worktree, name: `Use ${RUNNER_SECRET}` }));
    prepareSpoolDir(vps.spoolDir, ownUid());
    writeExcerpt(vps.spoolDir, SESSION_A, {
      at: NOW,
      text: `Token: ${RUNNER_SECRET}, and GH_TOKEN=abc ok. ${"word ".repeat(120)}`,
    });
    const secret = "the-runner-secret-of-another-shape";
    makeWorktree(main, join(vps.repos, "wt2"), `fix/${secret}`);
    writeSessionFile(
      vps,
      sessionFields({ pid: 102, sessionId: SESSION_B, cwd: join(vps.repos, "wt2") }),
    );
    const { sessions } = listed(service({ secrets: [RUNNER_SECRET, secret] }).sessions);
    const a = sessions.find((session) => session.id === SESSION_A);
    expect(a?.title).toBe(`Use ${REDACTED}`);
    expect(a?.excerpt?.startsWith(`Token: ${REDACTED}, and GH_TOKEN=${REDACTED} ok.`)).toBe(true);
    expect(a?.excerpt?.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(sessions.find((session) => session.id === SESSION_B)?.branch).toBe(`fix/${REDACTED}`);
    expect(JSON.stringify(sessions)).not.toContain(RUNNER_SECRET);
    expect(JSON.stringify(sessions)).not.toContain(secret);
  });

  it("shows no title that is only space once cut", () => {
    writeSessionFile(vps, sessionFields({ pid: 101, name: `${" ".repeat(MAX_TITLE_CHARS)}late` }));
    expect(listed(service().sessions).sessions[0]?.title).toBeNull();
  });

  it("drops a PR link the redaction would change, and cuts a long title", () => {
    const hexRepo = `https://github.com/guedesdiogo/${"ab".repeat(20)}/pull/1`;
    writeSessionFile(
      vps,
      sessionFields({ pid: 101, cwd: worktree, name: "t".repeat(MAX_TITLE_CHARS + 50) }),
    );
    writeTranscript(vps, SESSION_A, worktree, [prLink(hexRepo)]);
    const [session] = listed(service().sessions).sessions;
    expect(session?.prUrl).toBeNull();
    expect(session?.title).toBe("t".repeat(MAX_TITLE_CHARS));
  });

  it("shows no excerpt for an ended session, or one whose excerpt is only space", () => {
    writeSessionFile(vps, sessionFields({ pid: 101 }));
    writeSessionFile(vps, sessionFields({ pid: 102, sessionId: SESSION_B }));
    prepareSpoolDir(vps.spoolDir, ownUid());
    writeExcerpt(vps.spoolDir, SESSION_A, { at: NOW, text: "   " });
    writeExcerpt(vps.spoolDir, SESSION_B, { at: NOW, text: "Done." });
    writeEvents(vps, [spoolEvent("SessionEnd", NOW, { reason: "other" }, SESSION_B)]);
    const { sessions } = listed(service().sessions);
    expect(sessions.map(({ state, excerpt }) => [state, excerpt])).toEqual([
      ["ended", null],
      ["working", null],
    ]);
  });

  it("lists no session when the sessions folder can't be read", () => {
    expect(listed(service({ claudeDir: join(vps.root, "missing") }).sessions).sessions).toEqual([]);
  });

  it("uses the real clock, the process table and the runner's user when not told otherwise", () => {
    writeSessionFile(vps, sessionFields({ pid: process.pid }));
    writeEvents(vps, [spoolEvent("PermissionRequest", NOW)]);
    const sessions = new VpsSessions({
      claudeDir: vps.claudeDir,
      spoolDir: vps.spoolDir,
      workDir: vps.workDir,
      holds: () => false,
      secrets: [],
      warn: () => {},
    });
    const answer = sessions.list();
    expect(answer.now).toBeGreaterThan(NOW - 365 * 24 * HOUR);
    expect(answer.sessions[0]).toMatchObject({ alive: true, state: "waiting_permission" });
  });
});

describe("the spool, as the runner reads it", () => {
  it("is ignored, with one warning, when others may open its directory", () => {
    writeSessionFile(vps, sessionFields({ pid: 101 }));
    writeEvents(vps, [spoolEvent("PermissionRequest", NOW)]);
    writeExcerpt(vps.spoolDir, SESSION_A, { at: NOW, text: "Hi." });
    chmodSync(vps.spoolDir, 0o755);
    const { sessions, warnings } = service();
    expect(listed(sessions).sessions[0]).toMatchObject({ state: "working", excerpt: null });
    sessions.waits(0);
    expect(warnings).toEqual([
      `The session-event spool ${vps.spoolDir} isn't a directory of this user that no one else may open: its events are ignored`,
    ]);
    // Nothing in it is deleted either.
    expect(existsSync(join(vps.spoolDir, `excerpt-${SESSION_A}.json`))).toBe(true);
  });

  it("is simply empty before the hook first runs", () => {
    writeSessionFile(vps, sessionFields({ pid: 101 }));
    const { sessions, warnings } = service();
    expect(listed(sessions).sessions[0]?.state).toBe("working");
    expect(warnings).toEqual([]);
  });
});

describe("the excerpts' retention", () => {
  const excerptOf = (session: string) => readExcerpt(vps.spoolDir, session);

  it("deletes an ended session's excerpt, one older than 7 days, and one whose session is gone", () => {
    writeSessionFile(vps, sessionFields({ pid: 101 }));
    writeSessionFile(vps, sessionFields({ pid: 9_102, sessionId: SESSION_B }));
    writeSessionFile(vps, sessionFields({ pid: 103, sessionId: SESSION_C }));
    prepareSpoolDir(vps.spoolDir, ownUid());
    const gone = "dddddddd-1111-4222-8333-444444444444";
    writeExcerpt(vps.spoolDir, SESSION_A, { at: NOW - EXCERPT_RETENTION_MS + 1, text: "kept" });
    writeExcerpt(vps.spoolDir, SESSION_B, { at: NOW, text: "ended" });
    writeExcerpt(vps.spoolDir, SESSION_C, { at: NOW - EXCERPT_RETENTION_MS, text: "old" });
    writeExcerpt(vps.spoolDir, gone, { at: NOW, text: "gone" });
    writeFileSync(
      join(vps.spoolDir, `excerpt-${"eeeeeeee-1111-4222-8333-444444444444"}.json`),
      "{",
    );
    service().sessions.waits(0);
    expect(excerptOf(SESSION_A)?.text).toBe("kept");
    for (const session of [SESSION_B, SESSION_C, gone, "eeeeeeee-1111-4222-8333-444444444444"]) {
      expect(existsSync(join(vps.spoolDir, `excerpt-${session}.json`))).toBe(false);
    }
  });

  it("keeps the excerpt of a session it didn't see when it couldn't read every session file", () => {
    prepareSpoolDir(vps.spoolDir, ownUid());
    writeExcerpt(vps.spoolDir, SESSION_A, { at: NOW, text: "kept" });
    service({ claudeDir: join(vps.root, "missing") }).sessions.list();
    expect(excerptOf(SESSION_A)?.text).toBe("kept");
  });

  it("removes a hook's leftover temporary file after a minute", () => {
    prepareSpoolDir(vps.spoolDir, ownUid());
    const fresh = join(vps.spoolDir, `.excerpt-${SESSION_A}.11.tmp`);
    const stale = join(vps.spoolDir, `.excerpt-${SESSION_B}.12.tmp`);
    writeFileSync(fresh, "");
    writeFileSync(stale, "");
    const seconds = (time: number) => time / 1_000;
    utimesSync(fresh, seconds(NOW - 59_000), seconds(NOW - 59_000));
    utimesSync(stale, seconds(NOW - MINUTE), seconds(NOW - MINUTE));
    // One that can't be removed is left, without failing the answer.
    const stuck = join(vps.spoolDir, `.excerpt-${SESSION_C}.13.tmp`);
    mkdirSync(stuck);
    utimesSync(stuck, seconds(NOW - HOUR), seconds(NOW - HOUR));
    service().sessions.list();
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(stuck)).toBe(true);
  });
});

describe("VpsSessions.waits", () => {
  it("lists the open waits opened since then, oldest first, with their kind, title and repository", () => {
    writeSessionFile(vps, sessionFields({ pid: 101, cwd: worktree }));
    writeSessionFile(
      vps,
      sessionFields({ pid: 102, sessionId: SESSION_B, cwd: null, name: undefined }),
    );
    writeSessionFile(vps, sessionFields({ pid: 103, sessionId: SESSION_C }));
    writeEvents(vps, [
      spoolEvent("PermissionRequest", NOW - 2 * MINUTE, {}, SESSION_B),
      spoolEvent("Notification", NOW - MINUTE, { type: "elicitation_dialog" }, SESSION_A),
      spoolEvent("PermissionRequest", NOW - 5 * MINUTE, {}, SESSION_C),
      spoolEvent("PostToolUse", NOW - 4 * MINUTE, {}, SESSION_C),
    ]);
    expect(waited(service().sessions, NOW - 2 * MINUTE)).toEqual({
      ok: true,
      now: NOW,
      truncated: false,
      waits: [
        {
          sessionId: SESSION_B,
          kind: "permission",
          openedAt: NOW - 2 * MINUTE,
          title: null,
          repository: null,
        },
        {
          sessionId: SESSION_A,
          kind: "question",
          openedAt: NOW - MINUTE,
          title: "Review the runner's sessions",
          repository: "kelpie",
        },
      ],
    });
    expect(waited(service().sessions, NOW).waits).toEqual([]);
  });
});

describe("a session file's own wait", () => {
  it("is listed, and its wait sent to the notices with the same session and time, never its text", () => {
    const secretText = `input needed ${RUNNER_SECRET}`;
    writeSessionFile(
      vps,
      sessionFields({
        pid: 101,
        cwd: worktree,
        status: "waiting",
        waitingFor: "permission prompt",
        statusUpdatedAt: NOW - 2 * MINUTE,
      }),
    );
    writeSessionFile(
      vps,
      sessionFields({
        pid: 102,
        sessionId: SESSION_B,
        status: "waiting",
        waitingFor: secretText,
        statusUpdatedAt: NOW - MINUTE,
      }),
    );
    const { sessions } = listed(service().sessions);
    expect(sessions.map(({ id, state, since }) => [id, state, since])).toEqual([
      [SESSION_B, "waiting_answer", NOW - MINUTE],
      [SESSION_A, "waiting_permission", NOW - 2 * MINUTE],
    ]);
    const { waits } = waited(service().sessions, 0);
    expect(waits.map(({ sessionId, kind, openedAt }) => [sessionId, kind, openedAt])).toEqual([
      [SESSION_A, "permission", NOW - 2 * MINUTE],
      [SESSION_B, "question", NOW - MINUTE],
    ]);
    for (const answer of [sessions, waits]) {
      const text = JSON.stringify(answer);
      expect(text).not.toContain("permission prompt");
      expect(text).not.toContain("input needed");
      expect(text).not.toContain(RUNNER_SECRET);
    }
  });

  it("joins the hooks' wait for the same prompt: told once, at the earlier time, of the hook's kind", () => {
    writeSessionFile(
      vps,
      sessionFields({
        pid: 101,
        status: "waiting",
        waitingFor: "permission prompt",
        statusUpdatedAt: NOW - MINUTE + 20,
      }),
    );
    writeEvents(vps, [spoolEvent("PermissionRequest", NOW - MINUTE, { question: true })]);
    expect(waited(service().sessions, 0).waits).toEqual([
      {
        sessionId: SESSION_A,
        kind: "question",
        openedAt: NOW - MINUTE,
        title: "Review the runner's sessions",
        repository: null,
      },
    ]);
  });

  it("closes once a hook says the session moved on", () => {
    writeSessionFile(
      vps,
      sessionFields({ pid: 101, status: "waiting", statusUpdatedAt: NOW - 2 * MINUTE }),
    );
    writeEvents(vps, [spoolEvent("PostToolUse", NOW - MINUTE)]);
    expect(waited(service().sessions, 0).waits).toEqual([]);
    expect(listed(service().sessions).sessions[0]?.state).toBe("working");
  });
});

describe("the answers' bounds", () => {
  it("keeps the list within its bytes, dropping excerpts first, then titles, then sessions", () => {
    prepareSpoolDir(vps.spoolDir, ownUid());
    // Control characters take 6 bytes each in JSON: the worst case for a bound.
    const heavy = "\u0001".repeat(MAX_EXCERPT_CHARS);
    for (let index = 0; index < MAX_VPS_SESSIONS + 5; index += 1) {
      const id = `${String(index).padStart(8, "0")}-1111-4222-8333-444444444444`;
      writeSessionFile(
        vps,
        sessionFields({
          pid: 1_000 + index,
          sessionId: id,
          cwd: worktree,
          name: heavy.slice(0, MAX_TITLE_CHARS),
          statusUpdatedAt: NOW - index,
        }),
      );
      writeExcerpt(vps.spoolDir, id, { at: NOW, text: heavy });
    }
    const answer = listed(service().sessions);
    expect(answer.truncated).toBe(true);
    expect(bytes(answer)).toBeLessThanOrEqual(MAX_SESSIONS_BYTES);
    expect(answer.sessions).toHaveLength(MAX_VPS_SESSIONS);
    // The most recent keep their excerpts longest.
    expect(answer.sessions[0]?.excerpt).toBe(heavy);
    expect(answer.sessions.at(-1)?.excerpt).toBeNull();
  });

  it("keeps the waits within theirs", () => {
    const heavy = "\u0001".repeat(MAX_TITLE_CHARS);
    const events = [];
    for (let index = 0; index < MAX_VPS_SESSIONS + 1; index += 1) {
      const id = `${String(index).padStart(8, "0")}-1111-4222-8333-444444444444`;
      writeSessionFile(
        vps,
        sessionFields({ pid: 1_000 + index, sessionId: id, cwd: worktree, name: heavy }),
      );
      events.push(spoolEvent("PermissionRequest", NOW - MINUTE + index, {}, id));
    }
    writeEvents(vps, events);
    const answer = waited(service().sessions, 0);
    expect(answer.truncated).toBe(true);
    expect(bytes(answer)).toBeLessThanOrEqual(MAX_WAITS_BYTES);
    expect(answer.waits[0]).toMatchObject({ title: heavy, repository: "kelpie" });
    expect(answer.waits.at(-1)?.title).toBeNull();
  });
});

describe("withinBytes", () => {
  type Item = { a: string | null; b: string | null };
  const wrap = (items: Item[], truncated: boolean) => ({ items, truncated });

  it("leaves what fits as it is", () => {
    const items = [{ a: "x", b: "y" }];
    expect(withinBytes(items, ["a"], wrap, 1_000, false)).toEqual({ items, truncated: false });
    expect(withinBytes(items, ["a"], wrap, 1_000, true)).toEqual({ items, truncated: true });
  });

  it("drops fields in order, from the last item up, then items, until it fits", () => {
    const items: Item[] = [
      { a: "a".repeat(10), b: "b".repeat(10) },
      { a: null, b: "b".repeat(10) },
      { a: "a".repeat(10), b: "b".repeat(10) },
    ];
    const size = (value: unknown) => bytes(value);
    const full = size(wrap(items, false));
    // Each `a` dropped saves 8 bytes: `"aaaaaaaaaa"` becomes `null`.
    expect(withinBytes(items, ["a", "b"], wrap, full - 8, false)).toEqual({
      items: [items[0], items[1], { a: null, b: "b".repeat(10) }],
      truncated: true,
    });
    const b = { a: null, b: "b".repeat(10) };
    expect(withinBytes(items, ["a", "b"], wrap, full - 16, false)).toEqual({
      items: [b, b, b],
      truncated: true,
    });
    const onlyFirst = withinBytes(
      items,
      ["a", "b"],
      wrap,
      size(wrap([{ a: null, b: null }], false)),
      false,
    );
    expect(onlyFirst).toEqual({ items: [{ a: null, b: null }], truncated: true });
    expect(withinBytes(items, ["a", "b"], wrap, 1, false)).toEqual({ items: [], truncated: true });
  });
});
