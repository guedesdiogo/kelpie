import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownUid, RunnerConfigError } from "../src/secrets.ts";
import { prepareWorkDir } from "../src/workdir.ts";

describe("prepareWorkDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kelpie-runner-workdir-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a missing work folder, and its parents, for the runner's user only", () => {
    const path = join(dir, "state", "claude-code");
    prepareWorkDir(path);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it("takes a work folder already there, of the runner's user, that no one else may open", () => {
    const path = join(dir, "claude-code");
    mkdirSync(path, { mode: 0o700 });
    expect(() => prepareWorkDir(path)).not.toThrow();
  });

  it.each([0o750, 0o705, 0o777])("refuses a work folder others may open (mode %o)", (mode) => {
    const path = join(dir, "claude-code");
    mkdirSync(path);
    chmodSync(path, mode);
    expect(() => prepareWorkDir(path)).toThrow(/chmod 700/);
  });

  it("refuses a work folder of another user", () => {
    const path = join(dir, "claude-code");
    mkdirSync(path, { mode: 0o700 });
    expect(() => prepareWorkDir(path, ownUid() + 1)).toThrow(/another user/);
  });

  it("refuses a symlink, even to a good work folder", () => {
    const target = join(dir, "real");
    mkdirSync(target, { mode: 0o700 });
    const path = join(dir, "claude-code");
    symlinkSync(target, path);
    expect(() => prepareWorkDir(path)).toThrow(/symlink/);
  });

  it("refuses a file where the work folder should be, or under it", () => {
    const path = join(dir, "claude-code");
    writeFileSync(path, "");
    expect(() => prepareWorkDir(path)).toThrow(RunnerConfigError);
    expect(() => prepareWorkDir(join(path, "inner"))).toThrow(/Can't create the work folder/);
  });
});
