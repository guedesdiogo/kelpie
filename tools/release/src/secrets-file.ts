import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs `run` with the path of a JSON file that holds `secrets`, for `wrangler deploy
 * --secrets-file`. The file lives in a folder of its own that only this user can open (`mkdtemp`
 * makes it 0700), and both are deleted as soon as `run` settles, whether it succeeded or not.
 */
export async function withSecretsFile<T>(
  secrets: Record<string, string>,
  run: (file: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "kelpie-secrets-"));
  try {
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    return await run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
