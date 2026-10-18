import { lstatSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readSmall } from "./files.ts";

// A session's repository and branch, from its working folder (ADR-0057 §3): read from git's own
// files, a few small reads each, and never by running git.

/** The most folders walked up from a session's, looking for its `.git`. */
const MAX_DEPTH = 64;
/** `.git` files, `HEAD` and `commondir` are a line each. */
const MAX_GIT_FILE_BYTES = 4_096;

export interface Checkout {
  /** The main checkout's folder name, for a worktree too. */
  repository: string | null;
  /** Null when HEAD is detached, or unreadable. */
  branch: string | null;
}

const NONE: Checkout = { repository: null, branch: null };

/** The checkout `cwd` is in: its own `.git`, or the nearest one up its folders. */
export function checkoutOf(cwd: string | null): Checkout {
  // A folder that is gone, as a removed worktree, would find its parent's repository instead.
  if (cwd === null || !isAbsolute(cwd) || !isDirectory(cwd)) return NONE;
  let dir = resolve(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const dotGit = join(dir, ".git");
    const kind = kindOf(dotGit);
    if (kind === "directory") return fromGitDir(dotGit, dotGit, dir);
    if (kind === "file") return fromGitFile(dotGit, dir);
    if (kind === "other") return NONE;
    const parent = dirname(dir);
    if (parent === dir) return NONE;
    dir = parent;
  }
  return NONE;
}

/** A worktree's or a submodule's `.git` file: `gitdir: <path>`, and its `commondir`, if any. */
function fromGitFile(dotGit: string, top: string): Checkout {
  const target = /^gitdir: (.+)$/m.exec(readSmall(dotGit, MAX_GIT_FILE_BYTES) ?? "")?.[1]?.trim();
  if (!target) return NONE;
  const gitDir = resolve(top, target);
  const common = readSmall(join(gitDir, "commondir"), MAX_GIT_FILE_BYTES)?.trim();
  return fromGitDir(gitDir, common ? resolve(gitDir, common) : gitDir, top);
}

function fromGitDir(gitDir: string, commonDir: string, top: string): Checkout {
  // A main checkout keeps `<folder>/.git`; anything else, as a submodule's, names its own folder.
  const repository = basename(commonDir) === ".git" ? basename(dirname(commonDir)) : basename(top);
  const head = readSmall(join(gitDir, "HEAD"), MAX_GIT_FILE_BYTES)?.trim() ?? "";
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  return { repository, branch };
}

function kindOf(path: string): "directory" | "file" | "other" | "missing" {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) return "directory";
    return stat.isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
