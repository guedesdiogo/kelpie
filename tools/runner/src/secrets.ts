import { readFileSync, statSync } from "node:fs";

/** A setting the runner can't start with. The message never quotes a secret. */
export class RunnerConfigError extends Error {
  override readonly name = "RunnerConfigError";
}

const MIN_LENGTH = 32;

/**
 * The secrets Kelpie may call with: the current one, and a next one during a rotation, one per line.
 * The file must be readable by its owner only, as SSH requires of a private key.
 */
export function loadSecrets(path: string): string[] {
  let mode: number;
  let text: string;
  try {
    mode = statSync(path).mode;
    text = readFileSync(path, "utf8");
  } catch {
    throw new RunnerConfigError(`Can't read the secret file ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new RunnerConfigError(`Other users can read ${path}: run chmod 600 on it`);
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
