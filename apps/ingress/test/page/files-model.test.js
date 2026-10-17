import { describe, expect, it } from "vitest";
import {
  changedFileSections,
  entriesOf,
  entryBreaks,
  fileChanges,
  freeSkillName,
  freshDrafts,
  memoryBudget,
  memoryOf,
  newSkill,
  originLine,
  repositoryOf,
  sectionOf,
  shownEntries,
  shownRules,
  shownSoul,
  sizeLabel,
  skillFields,
} from "../../public/webchat/files-model.js";
import { TEXTS } from "../../public/webchat/texts.js";

// The agent's own files in its editor (#381): Hermes's memory, a SKILL.md's fields, and one Save.

const V = (n) => String(n).repeat(40);
const FILES = {
  soul: { content: "# Soul", version: V(1) },
  rules: null,
  memory: { content: "one\n§\ntwo", version: V(2) },
  skills: [{ name: "brief", description: "Briefs.", content: "x", version: V(3), origin: null, edited: false }],
};

describe("Hermes's memory", () => {
  it("splits and joins entries exactly as Hermes does", () => {
    expect(entriesOf("")).toEqual([]);
    expect(entriesOf("one\n§\ntwo")).toEqual(["one", "two"]);
    expect(memoryOf(["  one ", "", "two\r\nlines"])).toBe("one\n§\ntwo\nlines");
    expect(entryBreaks("a\n§\nb")).toBe(true);
    expect(entryBreaks("a § b")).toBe(false);
  });

  it("counts characters as Python does, and says when it is near or over the limit", () => {
    expect(memoryBudget(["x".repeat(246)])).toEqual({ used: 246, limit: 2_200, over: 0, level: "ok" });
    expect(memoryBudget(["x".repeat(1_760)]).level).toBe("near");
    expect(memoryBudget(["😀".repeat(2_200)]).level).toBe("near");
    expect(memoryBudget(["x".repeat(1_000), "y".repeat(1_261)])).toEqual({
      used: 2_264,
      limit: 2_200,
      over: 64,
      level: "over",
    });
  });
});

describe("a SKILL.md's fields", () => {
  it("reads the name and description, and what the vault would refuse", () => {
    expect(skillFields(newSkill("pdf-forms", "Fills forms.", "PDF"))).toEqual({
      name: "pdf-forms",
      description: "Fills forms.",
      problem: null,
    });
    expect(skillFields("---\nname: 'quoted'\ndescription: \"Quoted.\"\n---\n")).toMatchObject({
      name: "quoted",
      problem: null,
    });
    expect(skillFields("# none").problem).toBe("frontmatter");
    expect(skillFields("---\nname: Bad Name\ndescription: x\n---\n").problem).toBe("name");
    expect(skillFields("---\nname: ok\n---\n").problem).toBe("description");
    expect(skillFields(`---\nname: ok\ndescription: ${"x".repeat(1_025)}\n---\n`).problem).toBe(
      "description_too_long",
    );
  });

  it("names a new skill with a name no other skill has", () => {
    expect(freeSkillName("nova-skill", new Set())).toBe("nova-skill");
    expect(freeSkillName("nova-skill", new Set(["nova-skill", "nova-skill-2"]))).toBe("nova-skill-3");
  });
});

describe("what a Save sends", () => {
  it("shows the drafts over what is saved", () => {
    const drafts = freshDrafts();
    expect([shownSoul(FILES, drafts), shownRules(FILES, drafts), shownEntries(FILES, drafts)]).toEqual([
      "# Soul",
      null,
      ["one", "two"],
    ]);
    drafts.rules = "# Mine";
    drafts.memory = ["one"];
    expect([shownRules(FILES, drafts), shownEntries(FILES, drafts)]).toEqual(["# Mine", ["one"]]);
    const empty = { soul: null, rules: null, memory: null, skills: [] };
    expect([shownSoul(empty, freshDrafts()), shownEntries(empty, freshDrafts())]).toEqual(["", []]);
  });

  it("knows which file sections changed", () => {
    expect(changedFileSections(null, freshDrafts())).toEqual([]);
    const drafts = freshDrafts();
    drafts.soul = "# Soul";
    drafts.memory = ["one ", "two"];
    drafts.skills.set("brief", { content: "x" });
    expect(changedFileSections(FILES, drafts)).toEqual([]);
    drafts.soul = "# New";
    drafts.rules = "";
    drafts.memory = ["one"];
    drafts.skills.set("brief", { content: null });
    expect(changedFileSections(FILES, drafts)).toEqual(["soul", "rules", "memory", "skills"]);
    const gone = freshDrafts();
    gone.skills.set("never", { content: null });
    expect(changedFileSections(FILES, gone)).toEqual([]);
  });

  it("sends each change with the version it started from, or the one a conflict moved it to", () => {
    const drafts = freshDrafts();
    drafts.soul = "# New";
    drafts.rules = "# Rules";
    drafts.memory = ["a", "b"];
    drafts.skills.set("brief", { content: "y" });
    drafts.skills.set("pdf", { install: { id: "f".repeat(32), hash: "sha256:h" } });
    expect(fileChanges(FILES, drafts, ["soul", "rules", "memory", "skills"], { soul: V(9) })).toEqual([
      { file: "soul", content: "# New", version: V(9) },
      { file: "rules", content: "# Rules", version: null },
      { file: "memory", content: "a\n§\nb", version: V(2) },
      { file: "skill", name: "brief", content: "y", version: V(3) },
      { file: "install", staged: "f".repeat(32), hash: "sha256:h", version: null },
    ]);
    expect(fileChanges(FILES, drafts, ["memory"])).toHaveLength(1);
    expect(fileChanges(FILES, drafts, ["skills"], { "skill:brief": V(7) })[0].version).toBe(V(7));
    expect(["soul", "skill", "install"].map((file) => sectionOf({ file }))).toEqual(["soul", "skills", "skills"]);
  });
});

describe("the review's words", () => {
  it("says sizes and origins", () => {
    expect(sizeLabel(512, "en")).toBe("512 B");
    expect(sizeLabel(14_200, "en")).toBe("14 KB");
    expect(sizeLabel(1_500_000, "pt-BR")).toBe("1,5 MB");
    const names = TEXTS["pt-BR"].editor.files;
    expect(originLine(null, names)).toBe("");
    expect(
      originLine({ kind: "github", owner: "exemplo", repo: "skills", commit: "3f2a91c".padEnd(40, "0") }, names),
    ).toBe("exemplo/skills · 3f2a91c");
    expect(originLine({ kind: "archive", filename: "a.zip" }, names)).toBe(names.origins.archive);
    expect(originLine({ kind: "unknown" }, names)).toBe("");
  });

  it("reads the repository an address names", () => {
    expect(repositoryOf("github.com/exemplo/skills/tree/main/pdf")).toBe("exemplo/skills");
    expect(repositoryOf("https://www.github.com/o/r.git")).toBe("o/r");
    expect(repositoryOf("gitlab.com/o/r")).toBeNull();
  });
});
