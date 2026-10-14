import { describe, expect, it } from "vitest";
import { changedFiles, gitAt, listFiles } from "../src/git.ts";
import { ships } from "../src/ships.ts";
import { tempRepo } from "./fakes.ts";

// Without -z, git quotes these: "apps/api/\303\251.ts" and "apps/api/line\nbreak.ts", quotes included.
const ACCENTED = "apps/api/é.ts";
const NEWLINE = "apps/api/line\nbreak.ts";

function history() {
  const repo = tempRepo();
  const base = repo.commit({ [ACCENTED]: "one", "apps/api/gone.ts": "one" });
  const head = repo.commit({ [ACCENTED]: "two", "apps/api/gone.ts": null, [NEWLINE]: "new" });
  return { repo, base, head, git: gitAt(repo.dir) };
}

describe("changedFiles", () => {
  it("returns each path as it is in the tree, with its status", () => {
    const { base, head, git } = history();
    expect(changedFiles(git, base, head)).toEqual([
      { status: "D", path: "apps/api/gone.ts" },
      { status: "A", path: NEWLINE },
      { status: "M", path: ACCENTED },
    ]);
  });

  it("returns nothing between a commit and itself", () => {
    const { head, git } = history();
    expect(changedFiles(git, head, head)).toEqual([]);
  });

  it("lets a deploy see that a non-ASCII path ships", () => {
    const { repo, head, git } = history();
    const next = repo.commit({ [ACCENTED]: "three" });
    expect(ships(changedFiles(git, head, next).map(({ path }) => path))).toBe(true);
  });
});

describe("listFiles", () => {
  it("returns each path as it is in the tree", () => {
    const { base, head, git } = history();
    expect(listFiles(git, base)).toEqual(["apps/api/gone.ts", ACCENTED]);
    expect(listFiles(git, head)).toEqual([NEWLINE, ACCENTED]);
  });
});
