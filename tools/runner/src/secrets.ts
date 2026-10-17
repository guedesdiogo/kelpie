import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** A setting the runner can't start with. The message never quotes a secret. */
export class RunnerConfigError extends Error {
  override readonly name = "RunnerConfigError";
}

const MIN_LENGTH = 32;

/**
 * The secrets Kelpie may call with: the current one, and a next one during a rotation, one per line.
 * The file must be a regular file of the runner's own user, readable by it only, as SSH requires of
 * a private key. It is opened once, without following a symlink, and checked through that same
 * handle, so it can't be swapped between the check and the read.
 */
export function loadSecrets(path: string, uid = ownUid()): string[] {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new RunnerConfigError(`Can't read the secret file ${path}, or it is a symlink`);
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RunnerConfigError(`${path} isn't a file`);
    if (stat.uid !== uid) throw new RunnerConfigError(`${path} belongs to another user`);
    if ((stat.mode & 0o077) !== 0) {
      throw new RunnerConfigError(`Other users can read ${path}: run chmod 600 on it`);
    }
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const secrets = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (secrets.length === 0) throw new RunnerConfigError(`${path} holds no secret`);
  if (secrets.length > 2) {
    throw new RunnerConfigError(
      `${path} holds more than two secrets: the current one, and the next during a rotation`,
    );
  }
  if (secrets.some((secret) => secret.length < MIN_LENGTH)) {
    throw new RunnerConfigError(
      `Each secret in ${path} needs at least ${MIN_LENGTH} characters, such as the output of openssl rand -hex 32`,
    );
  }
  return secrets;
}

/** The runner's user. Node's types make `getuid` optional, as Windows lacks it; the runner is Linux's. */
export function ownUid(): number {
  return (process.getuid as () => number)();
}
