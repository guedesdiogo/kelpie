import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { isPrivateDir } from "./files.ts";

// A message to a session's inbox (ADR-0069 §2): the Unix socket Claude Code binds for each
// session, where a process of the same user may post. The session reads it as another session's
// message: it approves nothing there and changes no configuration.

/** How long a post may take: Claude Code closes a connection with no line within 30 s. */
export const INBOX_TIMEOUT_MS = 5_000;

/** The one line a post sends, as Claude Code's own help shows a script's. */
export function inboxLineOf(text: string): string {
  // JSON leaves the line and paragraph separators as they are; a reader that splits on them
  // would see a broken line.
  return JSON.stringify({ type: "user", message: { role: "user", content: text } })
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * Whether `path` is an inbox to post to: a socket of `uid`'s, not a symlink, in a directory of
 * `uid`'s that no one else may open, as Claude Code makes them.
 */
export function isInbox(path: string, uid: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && stat.uid === uid && isPrivateDir(dirname(path), uid);
  } catch {
    return false;
  }
}

/**
 * Posts `text` and ends the connection: true once the line went. What the inbox answers, as a
 * notice that it holds the message, is ignored.
 */
export function postToInbox(
  path: string,
  text: string,
  timeoutMs = INBOX_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let sent = false;
    let settled = false;
    const socket = connect(path);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(sent), timeoutMs);
    socket.on("connect", () => {
      socket.end(`${inboxLineOf(text)}\n`, () => {
        sent = true;
      });
    });
    socket.on("data", () => {});
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(sent));
  });
}
