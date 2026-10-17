import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecrets, RunnerConfigError } from "../src/secrets.ts";

const CURRENT = "a".repeat(64);
const NEXT = "b".repeat(64);

describe("loadSecrets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kelpie-runner-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (text: string, mode = 0o600) => {
    const file = join(dir, "secret");
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
    return file;
  };

  it("reads the current secret, trimmed", () => {
    expect(loadSecrets(write(`  ${CURRENT}  \n`))).toEqual([CURRENT]);
  });

  it("reads a next secret on a second line, for a rotation", () => {
    expect(loadSecrets(write(`${CURRENT}\n\n${NEXT}\n`))).toEqual([CURRENT, NEXT]);
  });

  it("refuses a file that doesn't exist, naming it", () => {
    const missing = join(dir, "nope");
    expect(() => loadSecrets(missing)).toThrow(RunnerConfigError);
    expect(() => loadSecrets(missing)).toThrow(missing);
  });

  it("refuses a file without a secret", () => {
    expect(() => loadSecrets(write("\n  \n"))).toThrow(/no secret/);
  });

  it("refuses a secret under 32 characters, without quoting it", () => {
    const short = "s3cr3t-but-too-short";
    let message = "";
    try {
      loadSecrets(write(short));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/at least 32/);
    expect(message).not.toContain(short);
  });

  it("refuses more than two secrets", () => {
    expect(() => loadSecrets(write(`${CURRENT}\n${NEXT}\n${"c".repeat(64)}`))).toThrow(/two/);
  });

  it.each([0o640, 0o604, 0o644])("refuses a file others can read (mode %o)", (mode) => {
    expect(() => loadSecrets(write(CURRENT, mode))).toThrow(/chmod 600/);
  });

  it("refuses a symlink, even to a good secret file", () => {
    const link = join(dir, "link");
    symlinkSync(write(CURRENT), link);
    expect(() => loadSecrets(link)).toThrow(/symlink/);
  });

  it("refuses a directory", () => {
    const folder = join(dir, "folder");
    mkdirSync(folder);
    expect(() => loadSecrets(folder)).toThrow(/isn't a file/);
  });

  it("refuses a file that belongs to another user", () => {
    expect(() => loadSecrets(write(CURRENT), (process.getuid as () => number)() + 1)).toThrow(
      /another user/,
    );
  });
});
