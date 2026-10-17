import { lstatSync, mkdirSync } from "node:fs";
import { ownUid, RunnerConfigError } from "./secrets.ts";

/**
 * Makes Claude Code's work folder, or checks the one there: a directory, not a symlink, of the
 * runner's own user, which no one else may open. It holds the sessions' transcripts.
 */
export function prepareWorkDir(path: string, uid = ownUid()): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch {
    throw new RunnerConfigError(`Can't create the work folder ${path}`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new RunnerConfigError(`The work folder ${path} isn't a directory, or is a symlink`);
  }
  if (stat.uid !== uid)
    throw new RunnerConfigError(`The work folder ${path} belongs to another user`);
  if ((stat.mode & 0o077) !== 0) {
    throw new RunnerConfigError(
      `Other users can open the work folder ${path}: run chmod 700 on it`,
    );
  }
}
