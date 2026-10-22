import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkClaudeCode,
  claudeCodeDirsOf,
  type ProcessInfo,
  processInfo,
} from "../src/processes.ts";
import { ownUid } from "../src/secrets.ts";

const HOME = "/home/owner";
const DIRS = claudeCodeDirsOf(HOME, `${HOME}/.claude`);
const APP = `${HOME}/.claude/remote/ccd-cli/2.1.299-686c67ec1014`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kelpie-runner-proc-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A made-up `/proc/<pid>`, with a `comm` that holds spaces and parentheses, as one may. */
function fakeProc(pid: number, { uid = 1000, start = "42070362", exe = APP } = {}): string {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  const after = ["S", "1", ...Array.from({ length: 17 }, (_, index) => String(index)), start, "0"];
  writeFileSync(join(dir, "stat"), `${pid} (2.1.299 (x) y) ${after.join(" ")}\n`);
  writeFileSync(
    join(dir, "status"),
    `Name:\tclaude\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t1000\n`,
  );
  symlinkSync(exe, join(dir, "exe"));
  return root;
}

describe("processInfo", () => {
  it("reads a process's real user, its start time and its binary", () => {
    expect(processInfo(77, fakeProc(77))).toEqual({ uid: 1000, start: "42070362", exe: APP });
  });

  it("reads a binary replaced by an update by its old path", () => {
    expect(processInfo(77, fakeProc(77, { exe: `${APP} (deleted)` }))?.exe).toBe(APP);
  });

  it("reads none for a process that isn't there", () => {
    expect(processInfo(78, root)).toBeNull();
  });

  it("reads this test's own process from the system's /proc, on Linux", () => {
    if (process.platform !== "linux") return;
    const info = processInfo(process.pid);
    expect(info?.uid).toBe(ownUid());
    expect(info?.start).toMatch(/^\d+$/);
    expect(info?.exe).toBe(process.execPath);
  });
});

describe("checkClaudeCode", () => {
  const file = { pid: 77, procStart: "42070362" };
  const info =
    (overrides: Partial<ProcessInfo> = {}) =>
    () => ({
      uid: 1000,
      start: "42070362",
      exe: APP,
      ...overrides,
    });

  it("takes the session file's process when it is a Claude Code process of the runner's user", () => {
    expect(checkClaudeCode(file, { uid: 1000, dirs: DIRS, info: info() })).toBe("ok");
    const cli = info({ exe: `${HOME}/.local/share/claude/versions/2.1.303` });
    expect(checkClaudeCode(file, { uid: 1000, dirs: DIRS, info: cli })).toBe("ok");
    // A file from before Claude Code wrote `procStart` is taken on the rest.
    expect(
      checkClaudeCode({ pid: 77, procStart: null }, { uid: 1000, dirs: DIRS, info: info() }),
    ).toBe("ok");
  });

  it.each([
    ["another user's", info({ uid: 0 }), "not_claude_code"],
    [
      "started at another time, so another process on its pid",
      info({ start: "99" }),
      "not_claude_code",
    ],
    ["another binary", info({ exe: "/usr/bin/node" }), "not_claude_code"],
    [
      "a binary beside Claude Code's folder",
      info({ exe: `${HOME}/.claude/remote/ccd-cli-evil/x` }),
      "not_claude_code",
    ],
    ["of an unknown binary", info({ exe: null }), "not_claude_code"],
    ["gone", () => null, "ended"],
    ["on a server that can't say", () => "unsupported" as const, "unsupported"],
  ])("refuses a process that is %s", (_, read, expected) => {
    expect(checkClaudeCode(file, { uid: 1000, dirs: DIRS, info: read })).toBe(expected);
  });

  it("refuses a session file without a process", () => {
    expect(
      checkClaudeCode({ pid: null, procStart: null }, { uid: 1000, dirs: DIRS, info: info() }),
    ).toBe("ended");
  });
});
