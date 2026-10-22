import { describe, expect, it } from "vitest";
import { cutRelease, cutReport, nextTag, releaseNotes } from "../src/cut.ts";
import { gitAt } from "../src/git.ts";
import type { Release } from "../src/github.ts";
import { closedIssue, comment, fakeGitHub, mergedPull, productionRun, tempRepo } from "./fakes.ts";

const MENTOR = "guedesdiogo";

/** Four commits on main, with v0.1.0 on the second. */
function history() {
  const repo = tempRepo();
  const git = gitAt(repo.dir);
  const [a, b, c, d] = [1, 2, 3, 4].map((n) =>
    repo.commit({ "file.txt": String(n) }, `change ${n}`),
  ) as [string, string, string, string];
  git(["tag", "v0.1.0", b]);
  return { repo, git, a, b, c, d };
}

const options = (overrides: Partial<Parameters<typeof cutRelease>[1]> = {}) => ({
  version: "minor",
  main: "main",
  mode: "preview" as const,
  mentor: MENTOR,
  ...overrides,
});

const draftOf = (tag: string, target: string, draft = true): Release => ({
  id: 3,
  tag,
  target,
  draft,
  prerelease: false,
  url: `https://github.com/guedesdiogo/kelpie/releases/tag/untagged-${tag}`,
});

describe("nextTag", () => {
  it("bumps the previous release", () => {
    expect(nextTag("v1.2.3", "patch")).toBe("v1.2.4");
    expect(nextTag("v1.2.3", "minor")).toBe("v1.3.0");
    expect(nextTag("v1.2.3", "major")).toBe("v2.0.0");
  });

  it("takes a version named outright when it comes after the previous one", () => {
    expect(nextTag(null, "v0.2.0")).toBe("v0.2.0");
    for (const version of ["v1.2.4", "v1.3.0", "v2.0.0"]) {
      expect(nextTag("v1.2.3", version)).toBe(version);
    }
    for (const version of ["v1.2.3", "v1.2.2", "v1.1.9", "v0.9.9"]) {
      expect(() => nextTag("v1.2.3", version)).toThrow(`${version} doesn't come after v1.2.3.`);
    }
  });

  it("needs the first version named, and refuses anything else", () => {
    expect(() => nextTag(null, "patch")).toThrow("There's no release yet");
    expect(() => nextTag("v1.2.3", "v1.3")).toThrow('"v1.3" isn\'t a version');
  });
});

describe("releaseNotes", () => {
  it("lists the pull requests, the issues and each critico issue's acceptance", () => {
    const contents = {
      commit: "0123456789abcdef0123456789abcdef01234567",
      base: "v0.1.0",
      commits: 2,
      pulls: [mergedPull(10, "mentee"), mergedPull(11, MENTOR)],
      issues: [closedIssue(1, ["critico"]), closedIssue(2)],
      critical: [{ issue: closedIssue(1, ["critico"]), pulls: [10], acceptance: null }],
      mentor: MENTOR,
    };
    const notes = releaseNotes("v0.2.0", contents, {
      base: { from: "deployed", tag: "v0.1.0" },
      contents,
    });
    expect(notes).toBe(
      [
        "Commit `0123456` · since v0.1.0",
        "",
        "## Pull requests",
        "",
        "- #10 Pull request 10",
        "- #11 Pull request 11",
        "",
        "## Issues",
        "",
        "- [guedesdiogo/kelpie#1](https://github.com/guedesdiogo/kelpie/issues/1) Issue 1 · `critico`",
        "- [guedesdiogo/kelpie#2](https://github.com/guedesdiogo/kelpie/issues/2) Issue 2",
        "",
        "## Mentor's acceptance (guedesdiogo)",
        "",
        "The critical gate reads from v0.1.0, the last release a Deploy run shipped, to v0.2.0.",
        "",
        "- [guedesdiogo/kelpie#1](https://github.com/guedesdiogo/kelpie/issues/1) Issue 1: missing, so the production deploy stops",
        "",
      ].join("\n"),
    );
  });

  it("says when there is nothing, and when it's the first release", () => {
    const contents = {
      commit: "0123456789abcdef0123456789abcdef01234567",
      base: null,
      commits: 1,
      pulls: [],
      issues: [],
      critical: [],
      mentor: MENTOR,
    };
    const notes = releaseNotes("v0.1.0", contents, {
      base: { from: "history", tag: null },
      contents,
    });
    expect(notes).toContain("· the first release");
    expect(notes).toContain("## Pull requests\n\nNone.");
    expect(notes).toContain("## Issues\n\nNone.");
    expect(notes).not.toContain("acceptance");
  });
});

describe("cutRelease", () => {
  it("previews main's tip as the next release, and creates nothing", async () => {
    const { git, a, b, c, d } = history();
    const github = fakeGitHub({ pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1)])] } });
    const cut = await cutRelease({ git, github }, options());
    expect(cut.tag).toBe("v0.2.0");
    expect(cut.commit).toBe(d);
    expect(cut.ci).toBeNull();
    expect(cut.notes).toContain("- #10 Pull request 10");
    // The notes start at the previous release; with no release shipped, the gate reads everything.
    expect(cut.gate.base).toEqual({ from: "history", tag: null });
    expect(github.asked).toEqual([
      [d, c],
      [d, c, b, a],
    ]);
    expect(github.saved).toEqual([]);
    expect(cutReport(cut, "preview")).toContain("`CI passed` on");
    expect(cutReport(cut, "preview")).toContain("A preview: nothing was created.");
  });

  it("saves a draft of a commit whose CI passed", async () => {
    const { git, c } = history();
    const github = fakeGitHub({ checks: { [c]: "success" } });
    const cut = await cutRelease({ git, github }, options({ target: c, mode: "draft" }));
    expect(github.saved).toEqual([
      {
        id: null,
        fields: { tag: "v0.2.0", target: c, name: "v0.2.0", body: cut.notes, draft: true },
      },
    ]);
    expect(cutReport(cut, "draft")).toContain("Draft saved: https://github.com/");
  });

  it("refuses a draft or a release while CI hasn't passed on the commit", async () => {
    const { git, d } = history();
    await expect(
      cutRelease({ git, github: fakeGitHub() }, options({ mode: "draft" })),
    ).rejects.toThrow("`CI passed` isn't green on");
    await expect(
      cutRelease(
        { git, github: fakeGitHub({ checks: { [d]: "failure" } }) },
        options({ mode: "publish" }),
      ),
    ).rejects.toThrow("(failure)");
  });

  it("refuses to publish while a critico issue lacks the mentor's acceptance", async () => {
    const { git, c, d } = history();
    const github = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])] },
      checks: { [d]: "success" },
    });
    await expect(cutRelease({ git, github }, options({ mode: "publish" }))).rejects.toThrow(
      "guedesdiogo/kelpie#1 lacks the mentor's acceptance",
    );
    expect(github.saved).toEqual([]);
    // A draft is still possible: it deploys nothing.
    await cutRelease({ git, github }, options({ mode: "draft" }));
    expect(github.saved).toHaveLength(1);
  });

  it("publishes a release whose critico issues are accepted", async () => {
    const { git, c, d } = history();
    const github = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])] },
      comments: { "guedesdiogo/kelpie#1": [comment(MENTOR, "**Aceite** · produção · link")] },
      checks: { [d]: "success" },
    });
    const cut = await cutRelease({ git, github }, options({ mode: "publish" }));
    expect(github.saved[0]?.fields.draft).toBe(false);
    expect(cut.notes).toContain("Issue 1: [«Aceite»](");
    expect(cutReport(cut, "publish")).toContain("The Deploy workflow deploys it now.");
  });

  it("lists what came since the previous release, and checks from the last release deployed", async () => {
    const { git, c, d } = history();
    git(["tag", "v0.2.0", c]); // blocked: its gate failed, and nothing shipped it
    const github = fakeGitHub({
      pulls: {
        [c]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])],
        [d]: [mergedPull(11, "mentee", [closedIssue(2)])],
      },
      checks: { [d]: "success" },
      runs: [productionRun("v0.1.0")],
    });
    const cut = await cutRelease({ git, github }, options());
    expect(cut.tag).toBe("v0.3.0");
    expect(cut.contents.pulls.map((pull) => pull.number)).toEqual([11]);
    expect(cut.gate.base).toEqual({ from: "deployed", tag: "v0.1.0" });
    expect(github.asked).toEqual([[d], [d, c]]);
    expect(cut.notes).toContain("· since v0.2.0");
    expect(cut.notes).not.toContain("- #10 ");
    expect(cut.notes).toContain(
      "The critical gate reads from v0.1.0, the last release a Deploy run shipped, to v0.3.0.",
    );
    expect(cut.notes).toContain("Issue 1: missing, so the production deploy stops");
    await expect(cutRelease({ git, github }, options({ mode: "publish" }))).rejects.toThrow(
      "guedesdiogo/kelpie#1 lacks the mentor's acceptance",
    );
  });

  it("refuses to publish over the first release's critico issue while nothing shipped", async () => {
    const { git, b, d } = history();
    const github = fakeGitHub({
      // v0.1.0's gate failed on #1, so no successful Deploy run names it.
      pulls: { [b]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])] },
      checks: { [d]: "success" },
    });
    const cut = await cutRelease({ git, github }, options());
    expect(cut.contents.pulls).toEqual([]);
    expect(cut.notes).toContain("· since v0.1.0");
    expect(cut.notes).toContain("Issue 1: missing, so the production deploy stops");
    await expect(cutRelease({ git, github }, options({ mode: "publish" }))).rejects.toThrow(
      "guedesdiogo/kelpie#1 lacks the mentor's acceptance",
    );
  });

  it("publishes the draft it saved, and refuses one for another commit", async () => {
    const { git, c, d } = history();
    const checks = { [c]: "success", [d]: "success" };
    const sameTarget = fakeGitHub({ checks, releases: [draftOf("v0.2.0", d)] });
    await cutRelease({ git, github: sameTarget }, options({ mode: "publish" }));
    expect(sameTarget.saved).toEqual([
      { id: 3, fields: expect.objectContaining({ tag: "v0.2.0", target: d, draft: false }) },
    ]);

    const older = fakeGitHub({ checks, releases: [draftOf("v0.2.0", c)] });
    await expect(cutRelease({ git, github: older }, options({ mode: "publish" }))).rejects.toThrow(
      `The draft v0.2.0 is for ${c.slice(0, 7)}, not ${d.slice(0, 7)}. Publish what it shows with --target ${c}`,
    );
    // Drafting again moves it.
    await cutRelease({ git, github: older }, options({ mode: "draft" }));
    expect(older.saved).toEqual([
      { id: 3, fields: expect.objectContaining({ target: d, draft: true }) },
    ]);
  });

  it("refuses a release that is published already", async () => {
    const { git, d } = history();
    const github = fakeGitHub({
      checks: { [d]: "success" },
      releases: [draftOf("v0.2.0", d, false)],
    });
    await expect(cutRelease({ git, github }, options({ mode: "draft" }))).rejects.toThrow(
      "v0.2.0 is published already.",
    );
  });

  it("refuses a commit off main's first-parent history, an unknown one, and an option", async () => {
    const { repo, git } = history();
    git(["checkout", "-q", "-b", "side"]);
    const side = repo.commit({ "file.txt": "side" });
    git(["checkout", "-q", "main"]);
    const github = fakeGitHub();
    await expect(cutRelease({ git, github }, options({ target: side }))).rejects.toThrow(
      `${side.slice(0, 7)} isn't on main's first-parent history.`,
    );
    await expect(cutRelease({ git, github }, options({ target: "nowhere" }))).rejects.toThrow(
      "nowhere isn't a commit here.",
    );
    await expect(cutRelease({ git, github }, options({ target: "--all" }))).rejects.toThrow(
      "--target takes a commit.",
    );
  });

  it("refuses a commit that is a release already, and a tag that exists", async () => {
    const { repo, git, b } = history();
    await expect(cutRelease({ git, github: fakeGitHub() }, options({ target: b }))).rejects.toThrow(
      `${b.slice(0, 7)} is v0.1.0 already.`,
    );

    git(["checkout", "-q", "-b", "side"]);
    git(["tag", "v0.3.0", repo.commit({ "file.txt": "side" })]);
    git(["checkout", "-q", "main"]);
    await expect(
      cutRelease({ git, github: fakeGitHub() }, options({ version: "v0.3.0" })),
    ).rejects.toThrow("The tag v0.3.0 exists already.");
  });

  it("needs the first version named", async () => {
    const { git } = history();
    git(["tag", "-d", "v0.1.0"]);
    await expect(cutRelease({ git, github: fakeGitHub() }, options())).rejects.toThrow(
      "There's no release yet",
    );
    const cut = await cutRelease({ git, github: fakeGitHub() }, options({ version: "v0.1.0" }));
    expect(cut.contents.commits).toBe(4);
  });
});
