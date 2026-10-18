import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
} from "node:fs";

// Bounded reads of files other programs write: Claude Code's, git's, and the session-event hook's.
// Each is opened without following a symlink, and none is read past its bound.

/** The tail of a regular file: its last `maxBytes`, and whether its start was left out. */
export interface Tail {
  text: string;
  partial: boolean;
}

/** The last `maxBytes` of the regular file at `path`, or null when it isn't one or can't be read. */
export function readTail(path: string, maxBytes: number): Tail | null {
  let fd: number | undefined;
  try {
    // Non-blocking, so a FIFO in a file's place can't hold the read: it isn't a file anyway.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - maxBytes);
    const bytes = new Uint8Array(stat.size - start);
    // One read of a regular file returns all of it, short only if the file shrank meanwhile.
    const read = readSync(fd, bytes, 0, bytes.byteLength, start);
    return { text: new TextDecoder().decode(bytes.subarray(0, read)), partial: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A small regular file's whole text; null when it is larger than `maxBytes`, or unreadable. */
export function readSmall(path: string, maxBytes: number): string | null {
  const tail = readTail(path, maxBytes);
  return tail && !tail.partial ? tail.text : null;
}

/**
 * The names in a directory, at most `max` of them, and whether that was all; null when it can't
 * be read. A directory of more than `max` entries is never read whole. With `filesOnly`, only its
 * regular files count, as the directory says, without a `stat` each.
 */
export function listNames(
  dir: string,
  max: number,
  filesOnly = false,
): { names: string[]; complete: boolean } | null {
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(dir);
    const names: string[] = [];
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) return { names, complete: true };
      if (filesOnly && !entry.isFile()) continue;
      if (names.length === max) return { names, complete: false };
      names.push(entry.name);
    }
  } catch {
    return null;
  } finally {
    handle?.closeSync();
  }
}

/** Whether `path` is a directory of `uid`'s, not a symlink, that no other user may open. */
export function isPrivateDir(path: string, uid: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Whether `path` is a regular file, not a symlink. */
export function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
