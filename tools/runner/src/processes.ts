import { readFileSync, readlinkSync } from "node:fs";
import { join, sep } from "node:path";
import type { SessionFile } from "./session-files.ts";

// What the runner checks before it ends a session (ADR-0069 §3): that the pid its session file
// names is still that session's Claude Code process, one of the runner's user's. Read from Linux's
// `/proc`; elsewhere the runner can't tell, and ends nothing.

/** A process as `/proc/<pid>` shows it. */
export interface ProcessInfo {
  /** Its real user. */
  uid: number;
  /** When it started, in clock ticks since boot, as `/proc/<pid>/stat` says and `procStart` too. */
  start: string;
  /** The binary it runs, or null when it can't be read. */
  exe: string | null;
}

/** The answers a check gives, as the runner's refusals name them. */
export type ProcessCheck = "ok" | "ended" | "not_claude_code" | "unsupported";

/**
 * The folders Claude Code's binaries run from: the Claude app's, which it installs on the server
 * under Claude Code's folder, and the native installer's, which a terminal's `claude` runs.
 */
export function claudeCodeDirsOf(home: string, claudeDir: string): string[] {
  return [
    join(claudeDir, "remote", "ccd-cli"),
    join(home, ".local", "share", "claude", "versions"),
  ];
}

/** The process's user, start time and binary; null when it isn't there or can't be read. */
export function processInfo(pid: number, proc = "/proc"): ProcessInfo | null {
  const dir = join(proc, String(pid));
  let stat: string;
  let status: string;
  try {
    // `/proc`'s files say they are empty, so they are read whole: each is a line or two.
    stat = readFileSync(join(dir, "stat"), "utf8");
    status = readFileSync(join(dir, "status"), "utf8");
  } catch {
    return null;
  }
  // The command's name, in parentheses, may hold spaces and parentheses itself: the fields follow
  // its last `)`, from the third, the state. The start time is the 22nd.
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const start = fields[19];
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  if (start === undefined || !/^\d+$/.test(start) || uid === undefined) return null;
  let exe: string | null;
  try {
    // A binary an update replaced reads with " (deleted)" after its path.
    exe = readlinkSync(join(dir, "exe")).replace(/ \(deleted\)$/, "");
  } catch {
    exe = null;
  }
  return { uid: Number(uid), start, exe };
}

/**
 * Whether the session file's process may be ended: it runs, as the runner's user, started when
 * the file says (when it says), and runs a binary from one of Claude Code's folders.
 */
export function checkClaudeCode(
  file: Pick<SessionFile, "pid" | "procStart">,
  options: {
    uid: number;
    dirs: readonly string[];
    info?: (pid: number) => ProcessInfo | null | "unsupported";
  },
): ProcessCheck {
  if (file.pid === null) return "ended";
  const read = (options.info ?? systemInfo)(file.pid);
  if (read === "unsupported") return "unsupported";
  if (read === null) return "ended";
  if (read.uid !== options.uid) return "not_claude_code";
  // Another process that took the pid since started at another time.
  if (file.procStart !== null && read.start !== file.procStart) return "not_claude_code";
  const exe = read.exe;
  if (exe === null || !options.dirs.some((dir) => exe.startsWith(`${dir}${sep}`))) {
    return "not_claude_code";
  }
  return "ok";
}

function systemInfo(pid: number): ProcessInfo | null | "unsupported" {
  return process.platform === "linux" ? processInfo(pid) : "unsupported";
}
