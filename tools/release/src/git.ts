import { execFileSync } from "node:child_process";
import type { BuildTag } from "./tags.ts";

/** A git repository: runs a git command there and returns its standard output. */
export type Git = (args: readonly string[]) => string;

export function gitAt(cwd: string): Git {
  return (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
}

export function repoRoot(cwd: string): string {
  return gitAt(cwd)(["rev-parse", "--show-toplevel"]).trim();
}

export interface ChangedFile {
  /** `A`, `M` or `D`: renames show as a deletion and an addition. */
  status: string;
  path: string;
}

export function changedFiles(git: Git, from: string, to: string): ChangedFile[] {
  return git(["diff", "--name-status", "--no-renames", from, to])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status: status.charAt(0), path };
    });
}

export function listFiles(git: Git, ref: string): string[] {
  return git(["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean);
}

export function show(git: Git, ref: string, path: string): string | null {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

export function hasCommit(git: Git, commit: string): boolean {
  try {
    git(["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The tag a deploy of `ref` carries (docs/admin-api.md, "Versions"). */
export function buildTagOf(git: Git, ref: string): BuildTag {
  return {
    build: Number(git(["rev-list", "--count", "--first-parent", ref]).trim()),
    commit: git(["rev-parse", "--short=7", ref]).trim(),
  };
}

export function subjectOf(git: Git, ref: string): string {
  return git(["log", "-1", "--format=%s", ref]).trim();
}

export function isClean(git: Git): boolean {
  return git(["status", "--porcelain"]).trim() === "";
}
