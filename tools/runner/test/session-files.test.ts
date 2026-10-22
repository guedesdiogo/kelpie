import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isAlive,
  MAX_SESSION_FILE_BYTES,
  MAX_SESSION_FILES,
  parseSessionFile,
  readSessionFiles,
} from "../src/session-files.ts";
import {
  type FakeVps,
  fakeVps,
  MINUTE,
  NOW,
  SESSION_A,
  SESSION_B,
  sessionFields,
  writeSessionFile,
} from "./fake-vps.ts";

const running = () => true;

describe("parseSessionFile", () => {
  it("takes the fields the runner uses from a session file", () => {
    expect(parseSessionFile(JSON.stringify(sessionFields()), running)).toEqual({
      id: SESSION_A,
      pid: process.pid,
      cwd: "/home/owner/Repos/kelpie",
      name: "Review the runner's sessions",
      status: "busy",
      statusUpdatedAt: NOW - 10 * MINUTE,
      startedAt: NOW - 5 * 60 * MINUTE,
      entrypoint: "claude-desktop",
      alive: true,
      waitingFor: "unknown",
      procStart: "42070362",
    });
  });

  it.each([
    ["a number", 42070362],
    ["text that isn't digits", "42070362 "],
    ["too many digits", "1".repeat(21)],
  ])("reads a procStart that is %s as unknown", (_, procStart) => {
    const fields = sessionFields({ procStart });
    expect(parseSessionFile(JSON.stringify(fields), running)?.procStart).toBeNull();
  });

  it.each([
    ["permission prompt", "permission"],
    ["input needed", "question"],
    [" Input Needed ", "question"],
    ["something new", "unknown"],
    [7, "unknown"],
    [undefined, "unknown"],
  ])("reads waitingFor %j as a wait of kind %s, never as its text", (waitingFor, kind) => {
    const fields = sessionFields({ status: "waiting", waitingFor });
    expect(parseSessionFile(JSON.stringify(fields), running)?.waitingFor).toBe(kind);
  });

  it.each(["busy", "idle", "waiting"])("takes the status %s", (status) => {
    expect(parseSessionFile(JSON.stringify(sessionFields({ status })), running)?.status).toBe(
      status,
    );
  });

  it("reads each field it doesn't know, or that is missing, as unknown", () => {
    const fields = sessionFields({
      pid: "123",
      cwd: "relative/path",
      name: "  ",
      status: "thinking",
      statusUpdatedAt: -5,
      startedAt: "yesterday",
      entrypoint: "Claude Desktop!",
      procStart: undefined,
    });
    expect(parseSessionFile(JSON.stringify(fields), running)).toEqual({
      id: SESSION_A,
      pid: null,
      cwd: null,
      name: null,
      status: "unknown",
      statusUpdatedAt: null,
      startedAt: null,
      entrypoint: null,
      alive: null,
      waitingFor: "unknown",
      procStart: null,
    });
    const bare = parseSessionFile(JSON.stringify({ sessionId: SESSION_A }), running);
    expect(bare).toMatchObject({ status: "unknown", pid: null, alive: null, name: null });
    const long = sessionFields({ cwd: `/${"x".repeat(4_096)}`, pid: 0 });
    expect(parseSessionFile(JSON.stringify(long), running)).toMatchObject({ cwd: null, pid: null });
  });

  it("says whether the session's process runs", () => {
    expect(parseSessionFile(JSON.stringify(sessionFields()), () => false)?.alive).toBe(false);
  });

  it.each([
    ["isn't JSON", "{"],
    ["is a list", "[]"],
    ["is null", "null"],
    ["has no session id", JSON.stringify(sessionFields({ sessionId: undefined }))],
    ["has a session id that isn't a UUID", JSON.stringify(sessionFields({ sessionId: "x" }))],
  ])("skips a file that %s", (_, text) => {
    expect(parseSessionFile(text, running)).toBeNull();
  });
});

describe("readSessionFiles", () => {
  let vps: FakeVps;
  beforeEach(() => {
    vps = fakeVps();
  });
  afterEach(() => vps.cleanup());

  it("reads each `.json` file of the sessions folder, and nothing else", () => {
    writeSessionFile(vps, sessionFields({ pid: 101 }));
    writeSessionFile(vps, sessionFields({ pid: 102, sessionId: SESSION_B }));
    writeFileSync(join(vps.claudeDir, "sessions", "101.abc.key"), "{}");
    writeFileSync(join(vps.claudeDir, "sessions", "bad.json"), "{");
    writeFileSync(
      join(vps.claudeDir, "sessions", "large.json"),
      JSON.stringify(sessionFields({ name: "x".repeat(MAX_SESSION_FILE_BYTES) })),
    );
    symlinkSync(
      join(vps.claudeDir, "sessions", "101.json"),
      join(vps.claudeDir, "sessions", "link.json"),
    );
    mkdirSync(join(vps.claudeDir, "sessions", "folder.json"));
    const read = readSessionFiles(vps.claudeDir, running);
    expect(read?.complete).toBe(true);
    expect(read?.files.map((file) => [file.id, file.pid]).sort()).toEqual([
      [SESSION_A, 101],
      [SESSION_B, 102],
    ]);
  });

  it("keeps one file per session: the one whose process runs, then the one that changed last", () => {
    writeSessionFile(vps, sessionFields({ pid: 201, statusUpdatedAt: NOW - MINUTE }));
    writeSessionFile(vps, sessionFields({ pid: 202, statusUpdatedAt: NOW }));
    // Whichever file is read first, the one whose process runs wins.
    for (const pid of [201, 202]) {
      const read = readSessionFiles(vps.claudeDir, (other) => other === pid);
      expect(read?.files.map((file) => file.pid)).toEqual([pid]);
    }
    expect(readSessionFiles(vps.claudeDir, () => false)?.files.map((file) => file.pid)).toEqual([
      202,
    ]);
  });

  it("keeps the first file read of a session when nothing tells two apart", () => {
    writeSessionFile(vps, sessionFields({ pid: 204, statusUpdatedAt: undefined }));
    writeSessionFile(vps, sessionFields({ pid: 205, statusUpdatedAt: undefined }));
    expect(readSessionFiles(vps.claudeDir, () => false)?.files).toHaveLength(1);
  });

  it("reads at most its bound of files, and says it didn't read them all", () => {
    for (let pid = 1; pid <= MAX_SESSION_FILES + 1; pid += 1) {
      writeFileSync(join(vps.claudeDir, "sessions", `${pid}.key`), "");
    }
    expect(readSessionFiles(vps.claudeDir, running)).toEqual({ files: [], complete: false });
  });

  it("is null when the sessions folder can't be read", () => {
    expect(readSessionFiles(join(vps.root, "missing"), running)).toBeNull();
  });

  it("checks a process with signal 0, by the real process table by default", () => {
    writeSessionFile(vps, sessionFields({ pid: process.pid }));
    expect(readSessionFiles(vps.claudeDir)?.files[0]?.alive).toBe(true);
  });
});

describe("isAlive", () => {
  it("is true for a running process, ours or another user's, and false for none", () => {
    expect(isAlive(process.pid)).toBe(true);
    // init runs as root: signal 0 answers EPERM, unless the tests run as root.
    expect(isAlive(1)).toBe(true);
    // Past Linux's largest pid.
    expect(isAlive(2 ** 22 + 1)).toBe(false);
  });
});
