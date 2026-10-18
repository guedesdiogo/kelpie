import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutOf } from "../src/git.ts";
import { makeCheckout, makeWorktree } from "./fake-vps.ts";

const NONE = { repository: null, branch: null };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kelpie-runner-git-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkoutOf", () => {
  it("reads a main checkout's folder name and branch, from it or a folder inside it", () => {
    const main = join(root, "kelpie");
    makeCheckout(main, "main");
    mkdirSync(join(main, "tools", "runner"), { recursive: true });
    expect(checkoutOf(main)).toEqual({ repository: "kelpie", branch: "main" });
    expect(checkoutOf(join(main, "tools", "runner"))).toEqual({
      repository: "kelpie",
      branch: "main",
    });
  });

  it("names a worktree by its main checkout's folder, with the worktree's own branch", () => {
    const main = join(root, "kelpie");
    makeCheckout(main, "main");
    const worktree = join(main, ".claude", "worktrees", "runner-sessions");
    makeWorktree(main, worktree, "feat/runner-vps-sessions");
    expect(checkoutOf(worktree)).toEqual({
      repository: "kelpie",
      branch: "feat/runner-vps-sessions",
    });
  });

  it("follows a relative gitdir", () => {
    const main = join(root, "app");
    makeCheckout(main);
    const worktree = join(root, "app-fix");
    makeWorktree(main, worktree, "fix/thing");
    writeFileSync(join(worktree, ".git"), "gitdir: ../app/.git/worktrees/fix-thing\n");
    expect(checkoutOf(worktree)).toEqual({ repository: "app", branch: "fix/thing" });
  });

  it("names a submodule, whose gitdir has no commondir, by its own folder", () => {
    const parent = join(root, "parent");
    makeCheckout(parent);
    const modules = join(parent, ".git", "modules", "lib");
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, "HEAD"), "ref: refs/heads/trunk\n");
    const lib = join(parent, "vendor", "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, ".git"), `gitdir: ${modules}\n`);
    expect(checkoutOf(lib)).toEqual({ repository: "lib", branch: "trunk" });
  });

  it("has no branch for a detached HEAD, or one it can't read", () => {
    const main = join(root, "kelpie");
    makeCheckout(main);
    writeFileSync(join(main, ".git", "HEAD"), "19d3f93a6b0c1d2e3f40516273849a0b1c2d3e4f\n");
    expect(checkoutOf(main)).toEqual({ repository: "kelpie", branch: null });
    rmSync(join(main, ".git", "HEAD"));
    expect(checkoutOf(main)).toEqual({ repository: "kelpie", branch: null });
  });

  it.each([
    ["has no gitdir line", "not a pointer\n"],
    ["is too large to be git's", `gitdir: ${"x".repeat(5_000)}\n`],
  ])("finds none when a `.git` file %s", (_, content) => {
    const dir = join(root, "odd");
    mkdirSync(dir);
    writeFileSync(join(dir, ".git"), content);
    expect(checkoutOf(dir)).toEqual(NONE);
  });

  it("finds none when `.git` is a symlink", () => {
    const main = join(root, "real");
    makeCheckout(main);
    const dir = join(root, "linked");
    mkdirSync(dir);
    symlinkSync(join(main, ".git"), join(dir, ".git"));
    expect(checkoutOf(dir)).toEqual(NONE);
  });

  it("finds none for a folder that is gone, even inside a repository", () => {
    const main = join(root, "kelpie");
    makeCheckout(main);
    expect(checkoutOf(join(main, ".claude", "worktrees", "removed"))).toEqual(NONE);
  });

  it("finds none for no folder, a relative one, a file, or one outside any repository", () => {
    expect(checkoutOf(null)).toEqual(NONE);
    expect(checkoutOf("relative/folder")).toEqual(NONE);
    writeFileSync(join(root, "file"), "");
    expect(checkoutOf(join(root, "file"))).toEqual(NONE);
    expect(checkoutOf(root)).toEqual(NONE);
  });

  it("stops looking 64 folders up", () => {
    const main = join(root, "deep");
    makeCheckout(main);
    const deep = join(main, ...Array.from({ length: 64 }, () => "d"));
    mkdirSync(deep, { recursive: true });
    expect(checkoutOf(deep)).toEqual(NONE);
    expect(checkoutOf(join(main, ...Array.from({ length: 63 }, () => "d")))).toEqual({
      repository: "deep",
      branch: "main",
    });
  });
});
