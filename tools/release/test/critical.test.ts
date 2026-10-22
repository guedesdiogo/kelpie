import { describe, expect, it } from "vitest";
import {
  forceRelease,
  forceReport,
  gateBase,
  gateReport,
  parseRelease,
  previousRelease,
  releaseContents,
  unaccepted,
} from "../src/critical.ts";
import { gitAt } from "../src/git.ts";
import { closedIssue, comment, fakeGitHub, mergedPull, productionRun, tempRepo } from "./fakes.ts";

const MENTOR = "guedesdiogo";
const RUN = "https://github.com/guedesdiogo/kelpie/actions/runs/42";

/** Five commits on main, with v0.1.0 on the second: the next release brings the last three. */
function history() {
  const repo = tempRepo();
  const git = gitAt(repo.dir);
  const [a, b, c, d, e] = [1, 2, 3, 4, 5].map((n) =>
    repo.commit({ "file.txt": String(n) }, `change ${n}`),
  ) as [string, string, string, string, string];
  git(["tag", "v0.1.0", b]);
  return { repo, git, a, b, c, d, e };
}

describe("parseRelease", () => {
  it("reads vX.Y.Z only", () => {
    expect(parseRelease("v1.20.3")).toEqual([1, 20, 3]);
    for (const tag of ["1.2.3", "v1.2", "v1.2.3-rc.1", "v1.2.3+build", "release"]) {
      expect(parseRelease(tag)).toBeNull();
    }
  });
});

describe("previousRelease", () => {
  it("finds the release tag behind a commit", () => {
    const { git, e } = history();
    expect(previousRelease(git, `${e}^`)).toBe("v0.1.0");
  });

  it("never starts a range at a prerelease", () => {
    const { git, d, e } = history();
    git(["tag", "v0.2.0-rc.1", d]);
    expect(previousRelease(git, `${e}^`)).toBe("v0.1.0");
  });

  it("answers null before the first release, and for the first commit", () => {
    const { git, a } = history();
    expect(previousRelease(git, a)).toBeNull();
    expect(previousRelease(git, `${a}^`)).toBeNull();
  });
});

describe("releaseContents", () => {
  it("reads the pull requests of the commits after the previous release, and their issues", async () => {
    const { git, c, d, e } = history();
    const github = fakeGitHub({
      pulls: {
        [c]: [mergedPull(10, "mentee", [closedIssue(3), closedIssue(2, ["type:story"])])],
        [e]: [mergedPull(12, "mentee", [closedIssue(4, [], "guedesdiogo/prumo")])],
      },
    });
    const contents = await releaseContents(
      { git, github },
      { commit: e, base: previousRelease(git, `${e}^`) },
      MENTOR,
    );
    expect(github.asked).toEqual([[e, d, c]]);
    expect(contents.base).toBe("v0.1.0");
    expect(contents.commits).toBe(3);
    expect(contents.pulls.map((pull) => pull.number)).toEqual([10, 12]);
    expect(contents.issues.map((issue) => `${issue.repo}#${issue.number}`)).toEqual([
      "guedesdiogo/kelpie#2",
      "guedesdiogo/kelpie#3",
      "guedesdiogo/prumo#4",
    ]);
    expect(contents.critical).toEqual([]);
    expect(github.read).toEqual([]);
  });

  it("takes the whole history for the first release", async () => {
    const { repo, e } = history();
    const git = gitAt(repo.dir);
    git(["tag", "-d", "v0.1.0"]);
    const github = fakeGitHub();
    const contents = await releaseContents(
      { git, github },
      { commit: e, base: previousRelease(git, `${e}^`) },
      MENTOR,
    );
    expect(contents.base).toBeNull();
    expect(contents.commits).toBe(5);
    expect(github.asked[0]).toHaveLength(5);
  });

  it("accepts a critico issue that a pull request by the mentor closes, without reading its comments", async () => {
    const { git, c, e } = history();
    const github = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "GuedesDiogo", [closedIssue(1, ["critico"])])] },
    });
    const contents = await releaseContents({ git, github }, { commit: e, base: "v0.1.0" }, MENTOR);
    expect(contents.critical).toEqual([
      { issue: closedIssue(1, ["critico"]), pulls: [10], acceptance: { by: "pull", pull: 10 } },
    ]);
    expect(github.read).toEqual([]);
    expect(unaccepted(contents)).toEqual([]);
  });

  it("accepts a critico issue with the mentor's «Aceite» comment, the latest one", async () => {
    const { git, c, e } = history();
    const github = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])] },
      comments: {
        "guedesdiogo/kelpie#1": [
          comment(MENTOR, "**Aceite** · staging · https://example.com/a", 1),
          comment(MENTOR, "**Aceite** · produção · https://example.com/b", 2),
        ],
      },
    });
    const contents = await releaseContents({ git, github }, { commit: e, base: "v0.1.0" }, MENTOR);
    expect(contents.critical[0]?.acceptance).toEqual({
      by: "comment",
      url: "https://github.com/guedesdiogo/kelpie/issues/1#issuecomment-2",
    });
    expect(unaccepted(contents)).toEqual([]);
  });

  it("doesn't accept an «Aceite» by anyone else, or a comment that doesn't start with it", async () => {
    const { git, c, e } = history();
    const github = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])] },
      comments: {
        "guedesdiogo/kelpie#1": [
          comment("mentee", "**Aceite** · produção · https://example.com/a"),
          comment(null, "**Aceite** · produção · https://example.com/b"),
          comment(MENTOR, "Not yet: **Aceite** · after the fix"),
          comment(MENTOR, "**Aceite forçado** · produção · v0.1.0 · run"),
        ],
      },
    });
    const contents = await releaseContents({ git, github }, { commit: e, base: "v0.1.0" }, MENTOR);
    expect(unaccepted(contents).map(({ issue }) => issue.number)).toEqual([1]);
    expect(github.read).toEqual(["guedesdiogo/kelpie#1"]);
  });

  it("joins an issue that two pull requests close, accepted if the mentor opened either", async () => {
    const { git, c, d, e } = history();
    const issue = closedIssue(1, ["critico"]);
    const byMentees = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [issue])], [d]: [mergedPull(11, "other", [issue])] },
    });
    const pending = await releaseContents(
      { git, github: byMentees },
      { commit: e, base: "v0.1.0" },
      MENTOR,
    );
    expect(pending.critical).toEqual([{ issue, pulls: [10, 11], acceptance: null }]);
    expect(byMentees.read).toEqual(["guedesdiogo/kelpie#1"]);

    const oneByMentor = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [issue])], [d]: [mergedPull(11, MENTOR, [issue])] },
    });
    const accepted = await releaseContents(
      { git, github: oneByMentor },
      { commit: e, base: "v0.1.0" },
      MENTOR,
    );
    expect(accepted.critical[0]?.acceptance).toEqual({ by: "pull", pull: 11 });
  });

  it("reads the critico label whatever its case", async () => {
    const { git, c, e } = history();
    const github = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1, ["Critico"])])] },
      labels: ["CRITICO"],
    });
    const contents = await releaseContents({ git, github }, { commit: e, base: "v0.1.0" }, MENTOR);
    expect(unaccepted(contents).map(({ issue }) => issue.number)).toEqual([1]);
  });

  it("fails when the repository has no critico label, rather than pass everything", async () => {
    const { git, e } = history();
    const github = fakeGitHub({ labels: ["security"] });
    await expect(
      releaseContents({ git, github }, { commit: e, base: "v0.1.0" }, MENTOR),
    ).rejects.toThrow("This repository has no `critico` label");
    expect(github.asked).toEqual([]);
  });

  it("finds no critico issue when none is labeled so", async () => {
    const { git, c, e } = history();
    const github = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1, ["security", "critical"])])] },
    });
    const contents = await releaseContents({ git, github }, { commit: e, base: "v0.1.0" }, MENTOR);
    expect(contents.critical).toEqual([]);
    expect(gateReport("v0.2.0", contents, { from: "deployed", tag: "v0.1.0" })).toContain(
      "No `critico` issue lacks the mentor's acceptance.",
    );
  });
});

describe("gateBase", () => {
  it("starts at the release the latest successful Deploy run shipped", async () => {
    const { git, b, d } = history();
    git(["tag", "v0.2.0", d]);
    // The newest run published v0.1.0; v0.2.0's ran before it.
    const github = fakeGitHub({
      runs: [
        productionRun("v0.1.0", { event: "release", branch: "v0.1.0", commit: b }),
        productionRun("v0.2.0"),
      ],
    });
    expect(await gateBase({ git, github })).toEqual({ from: "deployed", tag: "v0.1.0" });
  });

  it("reads everything when the latest run's tag isn't here", async () => {
    const { git, d } = history();
    git(["tag", "v0.2.0", d]);
    const github = fakeGitHub({ runs: [productionRun("v0.9.9"), productionRun("v0.1.0")] });
    expect(await gateBase({ git, github })).toEqual({ from: "history", tag: null });
  });

  it.each([
    ["by hand from another branch", { branch: "feature" }],
    ["by hand from a branch named like the tag", { branch: "v0.1.0" }],
    ["on a push from main", { event: "push" }],
    ["on a release, at another commit than its tag's", { event: "release", branch: "v0.1.0" }],
    ["named for a prerelease", { title: "Production v0.1.0-rc.1" }],
    ["named otherwise", { title: "Deploy" }],
  ])("doesn't count a run %s", async (_, how) => {
    const { git } = history();
    const github = fakeGitHub({ runs: [{ ...productionRun("v0.1.0"), ...how }] });
    expect(await gateBase({ git, github })).toEqual({ from: "history", tag: null });
  });

  it("reads everything while no Deploy run shipped a release, previous tags or not", async () => {
    const { git } = history();
    expect(await gateBase({ git, github: fakeGitHub() })).toEqual({ from: "history", tag: null });
  });

  it("keeps blocking the first release's critico issue in the next one, before anything ships", async () => {
    const { git, a, b, c, d, e } = history();
    git(["tag", "-d", "v0.1.0"]);
    git(["tag", "v0.1.0", c]); // the first release: its gate failed, so no successful run names it
    git(["tag", "v0.2.0", e]);
    const github = fakeGitHub({
      pulls: { [b]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])] },
    });
    const base = await gateBase({ git, github });
    expect(base).toEqual({ from: "history", tag: null });
    const contents = await releaseContents({ git, github }, { commit: e, base: base.tag }, MENTOR);
    expect(github.asked).toEqual([[e, d, c, b, a]]);
    expect(unaccepted(contents).map(({ issue }) => issue.number)).toEqual([1]);
    expect(gateReport("v0.2.0", contents, base)).toContain(
      "Everything up to v0.2.0: no release a Deploy run shipped is here to start from.",
    );
  });

  it("keeps blocking a release's critico issue in every later release until one deploys", async () => {
    const { git, c, d, e } = history();
    git(["tag", "v0.2.0", c]); // blocked: its gate failed, so no successful run names it
    git(["tag", "v0.3.0", e]);
    const github = fakeGitHub({
      pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])] },
      runs: [productionRun("v0.1.0")],
    });
    const base = await gateBase({ git, github });
    expect(base).toEqual({ from: "deployed", tag: "v0.1.0" });
    const contents = await releaseContents({ git, github }, { commit: e, base: base.tag }, MENTOR);
    expect(github.asked).toEqual([[e, d, c]]);
    expect(unaccepted(contents).map(({ issue }) => issue.number)).toEqual([1]);
  });

  it("finds nothing to check when a deployed release already contains the commit", async () => {
    const { git, c, e } = history();
    git(["tag", "v0.2.0", c]);
    git(["tag", "v0.3.0", e]);
    // v0.3.0 shipped; production goes back to v0.2.0 through the Deploy workflow.
    const github = fakeGitHub({ runs: [productionRun("v0.3.0")] });
    const base = await gateBase({ git, github });
    const contents = await releaseContents({ git, github }, { commit: c, base: base.tag }, MENTOR);
    expect(contents.commits).toBe(0);
    expect(unaccepted(contents)).toEqual([]);
  });

  it("fails when GitHub fails, never reading that as no critico issue", async () => {
    const { git, c, e } = history();
    const failing = (what: "successfulRuns" | "hasLabel" | "mergedPulls" | "comments") => {
      const github = fakeGitHub({
        pulls: { [c]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])] },
      });
      github[what] = async () => {
        throw new Error(`${what} failed`);
      };
      return github;
    };
    await expect(gateBase({ git, github: failing("successfulRuns") })).rejects.toThrow(
      "successfulRuns failed",
    );
    for (const what of ["hasLabel", "mergedPulls", "comments"] as const) {
      await expect(
        releaseContents({ git, github: failing(what) }, { commit: e, base: "v0.1.0" }, MENTOR),
      ).rejects.toThrow(`${what} failed`);
    }
  });
});

describe("gateReport", () => {
  it("lists each critico issue and how it stands, and says how to go on", async () => {
    const { git, c, d, e } = history();
    const github = fakeGitHub({
      pulls: {
        [c]: [mergedPull(10, "mentee", [closedIssue(1, ["critico"])])],
        [d]: [mergedPull(11, MENTOR, [closedIssue(2, ["critico"])])],
      },
    });
    const report = gateReport(
      "v0.2.0",
      await releaseContents({ git, github }, { commit: e, base: "v0.1.0" }, MENTOR),
      { from: "deployed", tag: "v0.1.0" },
    );
    expect(report).toContain("### Critical gate · v0.2.0");
    expect(report).toContain("From v0.1.0, the last release a Deploy run shipped, to v0.2.0.");
    expect(report).toContain("3 commits, 2 pull requests, 2 issues closed, 2 `critico`.");
    expect(report).toContain(
      "- [guedesdiogo/kelpie#1](https://github.com/guedesdiogo/kelpie/issues/1) Issue 1: missing, so the production deploy stops",
    );
    expect(report).toContain(
      "- [guedesdiogo/kelpie#2](https://github.com/guedesdiogo/kelpie/issues/2) Issue 2: pull request #11, opened by the mentor",
    );
    expect(report).toContain("1 `critico` issue lacks the mentor's acceptance");
    expect(report).toContain("`PRUMO_DONOS`");
  });

  it("says where the range starts when no release deployed yet", () => {
    const contents = {
      commit: "a".repeat(40),
      base: null,
      commits: 1,
      pulls: [],
      issues: [],
      critical: [],
      mentor: MENTOR,
    };
    const report = gateReport("v1.0.0", contents, { from: "history", tag: null });
    expect(report).toContain(
      "Everything up to v1.0.0: no release a Deploy run shipped is here to start from.",
    );
    expect(report).toContain("1 commit, 0 pull requests, 0 issues closed");
  });
});

describe("forceRelease", () => {
  const missing = [1, 2].map((number) => ({
    issue: closedIssue(number, ["critico"]),
    pulls: [10],
    acceptance: null,
  }));
  const options = { actor: "guedesdiogo", reason: "login is down", runUrl: RUN, mentor: MENTOR };

  it("opens the retroactive review for the mentor, then records the force on each issue", async () => {
    const github = fakeGitHub();
    const record = await forceRelease(github, "v0.2.0", missing, options);
    expect(github.opened).toEqual([
      {
        title: "Revisão retroativa · v0.2.0 · aceite forçado",
        body: [
          "guedesdiogo forced v0.2.0 to production without the mentor's «**Aceite**» on the issues below.",
          "",
          "Dono: guedesdiogo",
          "Motivo: login is down",
          `Run: ${RUN}`,
          "",
          "Issues:",
          "- guedesdiogo/kelpie#1 Issue 1",
          "- guedesdiogo/kelpie#2 Issue 2",
          "",
          "Review each one in production, then comment «**Aceite** · produção · <link>» on it, or open the fix.",
        ].join("\n"),
        assignees: [MENTOR],
        labels: ["critico"],
      },
    ]);
    const retro = "https://github.com/guedesdiogo/kelpie/issues/901";
    expect(github.commented).toEqual(
      [1, 2].map((issue) => ({
        repo: "guedesdiogo/kelpie",
        issue,
        body: [
          `**Aceite forçado** · produção · v0.2.0 · ${RUN}`,
          "",
          "Dono: guedesdiogo",
          "Motivo: login is down",
          `Revisão retroativa: ${retro}`,
        ].join("\n"),
      })),
    );
    expect(record?.retro).toBe(retro);
    expect(record?.comments).toHaveLength(2);
    expect(forceReport("v0.2.0", record)).toContain(`- Retroactive review: ${retro}`);
  });

  it("keeps the reason on one line", async () => {
    const github = fakeGitHub();
    await forceRelease(github, "v0.2.0", missing.slice(0, 1), {
      ...options,
      reason: "  login\n is   down ",
    });
    expect(github.commented[0]?.body).toContain("\nMotivo: login is down\n");
  });

  it("needs a reason, and writes nothing when no issue lacks the acceptance", async () => {
    const github = fakeGitHub();
    await expect(forceRelease(github, "v0.2.0", [], { ...options, reason: " \n" })).rejects.toThrow(
      "Forcing a release needs a reason.",
    );
    const record = await forceRelease(github, "v0.2.0", [], options);
    expect(record).toBeNull();
    expect(github.opened).toEqual([]);
    expect(github.commented).toEqual([]);
    expect(forceReport("v0.2.0", record)).toContain("Nothing to force");
  });
});
