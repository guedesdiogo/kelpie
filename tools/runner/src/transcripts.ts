import { join } from "node:path";
import { isFile, listNames, readTail } from "./files.ts";
import { PR_URL, SESSION_ID } from "./protocol.ts";

// A session's pull request link, from its transcript (ADR-0057 §2). Only the transcript's last
// 1 MiB is read, and of it only the `pr-link` entries: never its messages.

/** How much of a transcript's end is read: a link written before it shows as none. */
export const MAX_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
/** The most project folders looked through for a transcript not where its folder's name says. */
export const MAX_PROJECT_DIRS = 1_000;
/** A `pr-link` entry is one short line, and starts as Claude Code writes it. */
const PR_LINK_PREFIX = '{"type":"pr-link"';
const MAX_PR_LINK_LINE = 4_096;

/**
 * Finds sessions' transcripts, `<claudeDir>/projects/<project>/<id>.jsonl`: first in the folder
 * Claude Code names after the session's working folder, then in each project folder, up to
 * MAX_PROJECT_DIRS of them. The project folders are listed once, when a session first needs it.
 */
export function transcriptFinder(
  claudeDir: string,
  list: typeof listNames = listNames,
): (id: string, cwd: string | null) => string | null {
  const projects = join(claudeDir, "projects");
  let names: string[] | undefined;
  return (id, cwd) => {
    if (!SESSION_ID.test(id)) return null;
    const file = `${id}.jsonl`;
    if (cwd !== null) {
      // Claude Code names the folder after the working folder, each character but letters and
      // digits made a dash.
      const path = join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), file);
      if (isFile(path)) return path;
    }
    names ??= list(projects, MAX_PROJECT_DIRS)?.names ?? [];
    for (const name of names) {
      const path = join(projects, name, file);
      if (isFile(path)) return path;
    }
    return null;
  };
}

/** The last GitHub pull request link in the transcript's last 1 MiB, or null. */
export function prLinkOf(path: string): string | null {
  const tail = readTail(path, MAX_TRANSCRIPT_TAIL_BYTES);
  if (!tail) return null;
  const lines = tail.text.split("\n");
  if (tail.partial) lines.shift();
  let link: string | null = null;
  for (const line of lines) {
    if (!line.startsWith(PR_LINK_PREFIX) || line.length > MAX_PR_LINK_LINE) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; prUrl?: unknown };
      if (entry.type === "pr-link" && typeof entry.prUrl === "string" && PR_URL.test(entry.prUrl)) {
        link = entry.prUrl;
      }
    } catch {
      // A line cut short, or not an entry.
    }
  }
  return link;
}
