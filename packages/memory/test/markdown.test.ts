import { describe, expect, it } from "vitest";
import { extractLinks, splitFrontmatter } from "../src/index.ts";

describe("splitFrontmatter", () => {
  it("splits a leading block", () => {
    expect(splitFrontmatter("---\nkind: person\n---\n# Ana\n")).toEqual({
      yaml: "kind: person",
      body: "# Ana\n",
    });
  });

  it("drops a BOM and accepts CRLF fences", () => {
    expect(splitFrontmatter("\u{FEFF}---\r\nkind: person\r\n---\r\n# Ana\r\n")).toEqual({
      yaml: "kind: person",
      body: "# Ana\r\n",
    });
  });

  it("accepts an empty block and a closing fence at the end of the file", () => {
    expect(splitFrontmatter("---\n---\nbody")).toEqual({ yaml: "", body: "body" });
    expect(splitFrontmatter("---\nkind: note\n---")).toEqual({ yaml: "kind: note", body: "" });
  });

  it("reads anything else as body", () => {
    expect(splitFrontmatter("# Title\n---\nx: 1\n---\n")).toEqual({
      yaml: null,
      body: "# Title\n---\nx: 1\n---\n",
    });
    expect(splitFrontmatter("---\nkind: note\nno closing fence")).toEqual({
      yaml: null,
      body: "---\nkind: note\nno closing fence",
    });
  });
});

describe("extractLinks", () => {
  const from = "memory/people/ana-souza.md";

  it("reads Obsidian wikilinks by name and by path", () => {
    expect(
      extractLinks(
        "Met [[Bruno Lima]] and [[memory/places/Lisboa|Lisbon]] at [[Café Central#Menu]] ([[Bruno Lima]]).",
        from,
      ),
    ).toEqual([
      { kind: "link", by: "name", target: "bruno lima" },
      { kind: "link", by: "path", target: "memory/places/lisboa" },
      { kind: "link", by: "name", target: "café central" },
    ]);
  });

  it("tells embeds apart and drops links to anything but a note", () => {
    expect(extractLinks("![[Recipe]] ![[photo.png|100]] [[doc.pdf]] [[Plan.md]]", from)).toEqual([
      { kind: "embed", by: "name", target: "recipe" },
      { kind: "link", by: "name", target: "plan" },
    ]);
  });

  it("unescapes a table's pipe and skips same-note links", () => {
    expect(extractLinks("| [[Ana Souza\\|Ana]] | [[#Heading]] | [[x#^block]] |", from)).toEqual([
      { kind: "link", by: "name", target: "ana souza" },
      { kind: "link", by: "name", target: "x" },
    ]);
  });

  it("skips links in code", () => {
    const body = [
      "`[[inline]]` and ``[[double `tick`]]`` but [[real]]",
      "```md",
      "[[fenced]]",
      "```",
      "~~~~",
      "[[tilde]]",
      "~~~",
      "[[still fenced]]",
      "~~~~",
      "[[after]]",
    ].join("\n");
    expect(extractLinks(body, from).map((link) => link.target)).toEqual(["real", "after"]);
  });

  it("resolves Markdown links relative to the note, and only to .md files", () => {
    expect(
      extractLinks(
        "[a](../places/Lisboa.md) [b](/knowledge/ideas.md#x) [c](Bruno%20Lima.md) [d](https://x.org/a.md) [e](../../../../out.md) [f](folder) ![g](pic.md)",
        from,
      ),
    ).toEqual([
      { kind: "link", by: "path", target: "memory/places/lisboa" },
      { kind: "link", by: "path", target: "knowledge/ideas" },
      { kind: "link", by: "path", target: "memory/people/bruno lima" },
    ]);
  });

  it("resolves relative wikilinks against the note's folder", () => {
    expect(extractLinks("[[../places/Lisboa]] [[./Bruno]]", from)).toEqual([
      { kind: "link", by: "path", target: "memory/places/lisboa" },
      { kind: "link", by: "path", target: "memory/people/bruno" },
    ]);
  });
});
