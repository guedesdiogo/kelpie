import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareSpoolDir, type SpoolEvent, spoolDirOf } from "../src/spool.ts";

// A stand-in for the owner's VPS (ADR-0057): a home with Claude Code's folder, its session files
// and transcripts, and the session-event hook's spool. Every value is made up here: session files
// take the fields Claude Code 2.1.299 writes, by name and type only.

export const SESSION_A = "aaaaaaaa-1111-4222-8333-444444444444";
export const SESSION_B = "bbbbbbbb-1111-4222-8333-444444444444";
export const SESSION_C = "cccccccc-1111-4222-8333-444444444444";
/** The runner's own secret, as `openssl rand -hex 32` makes one. */
export const RUNNER_SECRET = "5f3c9a7e1b2d4f6a8c0e2b4d6f8a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a";

/** 2026-10-17 18:00 UTC, the tests' now. */
export const NOW = Date.UTC(2026, 9, 17, 18, 0, 0);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export interface FakeVps {
  root: string;
  home: string;
  claudeDir: string;
  spoolDir: string;
  /** The runner's own work folder. */
  workDir: string;
  /** Folders the sessions run in. */
  repos: string;
  cleanup(): void;
}

export function fakeVps(): FakeVps {
  const root = mkdtempSync(join(tmpdir(), "kelpie-runner-vps-"));
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const workDir = join(home, ".local", "state", "kelpie-runner", "claude-code");
  const repos = join(home, "Repos");
  for (const dir of [join(claudeDir, "sessions"), join(claudeDir, "projects"), workDir, repos]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return {
    root,
    home,
    claudeDir,
    spoolDir: spoolDirOf(home),
    workDir,
    repos,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A session file as Claude Code writes it, every field made up, with `overrides` over them. */
export function sessionFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: process.pid,
    sessionId: SESSION_A,
    procStart: "42070362",
    cwd: "/home/owner/Repos/kelpie",
    startedAt: NOW - 5 * HOUR,
    version: "2.1.299",
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    entrypoint: "claude-desktop",
    messagingSocketPath: "/tmp/claude-sock",
    name: "Review the runner's sessions",
    nameSince: NOW - 5 * HOUR,
    updatedAt: NOW - 10 * MINUTE,
    status: "busy",
    statusUpdatedAt: NOW - 10 * MINUTE,
    hostSessionId: "local_made_up",
    bridgeSessionId: "bridge_made_up",
    ...overrides,
  };
}

/** Writes `<claudeDir>/sessions/<name>.json`. */
export function writeSessionFile(
  vps: FakeVps,
  fields: Record<string, unknown>,
  name = String(fields.pid ?? "session"),
): void {
  writeFileSync(join(vps.claudeDir, "sessions", `${name}.json`), JSON.stringify(fields));
}

export function spoolEvent(
  event: SpoolEvent["event"],
  at: number,
  extra: Partial<SpoolEvent> = {},
  session = SESSION_A,
): SpoolEvent {
  return { at, event, session, ...extra };
}

/** Writes the spool's newer events file, in its private directory, as the hook would. */
export function writeEvents(vps: FakeVps, events: SpoolEvent[]): void {
  if (!prepareSpoolDir(vps.spoolDir, process.getuid?.() as number)) throw new Error("spool");
  writeFileSync(
    join(vps.spoolDir, "events.ndjson"),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    { mode: 0o600 },
  );
}

/** A main checkout at `dir`, on `branch`, with git's own files only. */
export function makeCheckout(dir: string, branch = "main"): void {
  mkdirSync(join(dir, ".git", "worktrees"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

/** A worktree of the checkout at `main`, at `dir`, on `branch`, as `git worktree add` lays it. */
export function makeWorktree(main: string, dir: string, branch: string): void {
  const name = branch.replaceAll("/", "-");
  const gitDir = join(main, ".git", "worktrees", name);
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
}

/** A transcript's lines, written where Claude Code keeps it for `cwd`. */
export function writeTranscript(vps: FakeVps, id: string, cwd: string, lines: unknown[]): string {
  const path = join(vps.claudeDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return path;
}

/** A `pr-link` entry as Claude Code writes it. */
export function prLink(url: string, id = SESSION_A): Record<string, unknown> {
  return {
    type: "pr-link",
    sessionId: id,
    prNumber: Number(url.split("/").at(-1)),
    prUrl: url,
    prRepository: "guedesdiogo/kelpie",
    timestamp: new Date(NOW).toISOString(),
  };
}
