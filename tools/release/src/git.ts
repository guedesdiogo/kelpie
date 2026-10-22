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

/**
 * With `-z`, git writes each path as it is, NUL-terminated. Without it, git quotes a path with
 * non-ASCII or control characters, quotes included, so no prefix or pattern would match it.
 */
export function changedFiles(git: Git, from: string, to: string): ChangedFile[] {
  const fields = git(["diff", "-z", "--name-status", "--no-renames", from, to, "--"]).split("\0");
  const files: ChangedFile[] = [];
  // Each record is a status and a path; the output ends with a NUL, so the last field is empty.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    files.push({ status: (fields[i] as string).charAt(0), path: fields[i + 1] as string });
  }
  return files;
}

export function listFiles(git: Git, ref: string): string[] {
  return git(["ls-tree", "-r", "-z", "--name-only", ref]).split("\0").filter(Boolean);
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

/** Whether `descendant` contains `ancestor`, the same commit included. */
export function isAncestor(git: Git, ancestor: string, descendant: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** The commit a tag names, or null without that tag. */
export function tagCommit(git: Git, tag: string): string | null {
  try {
    return git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]).trim() || null;
  } catch {
    return null;
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
