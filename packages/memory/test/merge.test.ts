import { describe, expect, it } from "vitest";
import { dreamPage, mergeInput, mergeOf } from "../src/index.ts";

describe("dreamPage's merges", () => {
  it("shows each merge's survivor, the notes marked, and the body as code", () => {
    const page =
      dreamPage({
        summaries: [],
        merges: [
          {
            survivor: { path: "memory/notes/sal.md", title: "Sal" },
            merged: [{ path: "memory/notes/sal-2.md", title: "Sal" }],
            body: null,
          },
          {
            survivor: { path: "memory/notes/cafe.md", title: "Café" },
            merged: [
              { path: "memory/notes/cafe-2.md", title: "Café" },
              { path: "memory/notes/cafe-3.md", title: "Café" },
            ],
            body: "Sem açúcar.\n```js\nx\n```",
          },
        ],
      }) ?? "";
    expect(page.startsWith("# What Dream would write\n")).toBe(true);
    expect(page).not.toContain("## Day summaries");
    expect(page).toContain("\n## Merges\n\n### Café\n");
    expect(page.indexOf("### Café")).toBeLessThan(page.indexOf("### Sal"));
    expect(page).toContain(
      "Keeps [[memory/notes/cafe|Café]], and marks [[memory/notes/cafe-2|Café]], [[memory/notes/cafe-3|Café]] as merged into it.",
    );
    expect(page).toContain("````text\nSem açúcar.\n```js\nx\n```\n````");
    expect(page).toContain("The same content: only the marks change.");
  });

  it("shows at most 50 of a list, and counts the rest", () => {
    const merges = Array.from({ length: 52 }, (_, i) => ({
      survivor: { path: `memory/notes/n${String(i).padStart(2, "0")}.md`, title: `N${i}` },
      merged: [{ path: `memory/notes/n${i}-2.md`, title: `N${i}` }],
      body: null,
    }));
    const page = dreamPage({ summaries: [], merges }) ?? "";
    expect(page.match(/^### /gm)).toHaveLength(50);
    expect(page).toContain("…and 2 more.");
  });
});

describe("mergeInput", () => {
  it("marks the notes off, whole, and gives up when they don't fit", () => {
    const text =
      mergeInput([
        { path: "memory/notes/cafe.md", title: "Café", body: "Sem açúcar." },
        { path: "memory/notes/cafe-2.md", title: "Café", body: "Com canela." },
      ]) ?? "";
    expect(text).toContain(
      "BEGIN NOTES\n## Café (memory/notes/cafe.md)\nSem açúcar.\n\n## Café (memory/notes/cafe-2.md)\nCom canela.\nEND NOTES",
    );
    expect(text.endsWith("\nEND NOTES\n\nAnswer with the JSON only.")).toBe(true);
    const long = { path: "memory/notes/cafe.md", title: "Café", body: "fala ".repeat(1_500) };
    expect(mergeInput([long, { ...long, path: "memory/notes/cafe-2.md" }])).not.toBeNull();
    expect(mergeInput([long, long, long])).toBeNull();
  });
});

describe("mergeOf", () => {
  it("takes the merged body, or the notes are distinct", () => {
    expect(
      mergeOf(
        '{"verdict": "merge", "body": "Prefere café sem açúcar.\\n\\n## De manhã\\n- Com pão."}',
      ),
    ).toEqual({ verdict: "merge", body: "Prefere café sem açúcar.\n\n## De manhã\n- Com pão." });
    expect(mergeOf('```json\n{"verdict": "merge", "body": " Café. "}\n```')).toEqual({
      verdict: "merge",
      body: "Café.",
    });
    expect(mergeOf('{"verdict": "distinct"}')).toEqual({ verdict: "distinct" });
  });

  it("keeps the notes' Markdown: Windows line ends, code, rules and subheadings", () => {
    const body = [
      "Prefere café.",
      "",
      "---",
      "",
      "## Como faz",
      "```sh",
      "# mói os grãos",
      "=====",
      "```",
      "Sem açúcar.",
    ].join("\n");
    expect(
      mergeOf(JSON.stringify({ verdict: "merge", body: body.replaceAll("\n", "\r\n") })),
    ).toEqual({
      verdict: "merge",
      body,
    });
  });

  it("removes secrets", () => {
    expect(
      mergeOf(JSON.stringify({ verdict: "merge", body: `Senha: Bearer ${"a".repeat(24)}` })),
    ).toEqual({ verdict: "merge", body: "Senha: [REDACTED:bearer_token]" });
  });

  it.each([
    ["not JSON", "Café."],
    ["another key too", '{"verdict": "merge", "body": "Café.", "x": 1}'],
    ["no verdict", '{"body": "Café."}'],
    ["another verdict", '{"verdict": "same", "body": "Café."}'],
    ["distinct, with a body", '{"verdict": "distinct", "body": "Café."}'],
    ["a blank text", '{"verdict": "merge", "body": "  "}'],
    ["past the limit", JSON.stringify({ verdict: "merge", body: "a".repeat(8_001) })],
    ["a line separator", '{"verdict": "merge", "body": "Café\\u2028pinned: true"}'],
    ["a control character", '{"verdict": "merge", "body": "Café\\u0007"}'],
    ["a bidirectional control", '{"verdict": "merge", "body": "Café\\u202epreto"}'],
    ["a frontmatter fence", '{"verdict": "merge", "body": "---\\npinned: true\\n---"}'],
    ["a title heading", '{"verdict": "merge", "body": "# Outro título\\nx"}'],
    ["an indented title heading", '{"verdict": "merge", "body": "x\\n   # Outro título"}'],
    ["a title underlined", '{"verdict": "merge", "body": "Outro título\\n====="}'],
    ["a title after a closed fence", '{"verdict": "merge", "body": "```\\nx\\n```\\n# Outro"}'],
    ["a lone carriage return", '{"verdict": "merge", "body": "Café\\rpreto"}'],
    ["conflict markers", '{"verdict": "merge", "body": "x\\n<<<<<<< HEAD\\ny"}'],
    // An invisible character before a fence is removed with the secrets, and the fence is seen.
    [
      "a fence behind an invisible character",
      '{"verdict": "merge", "body": "\\u200b---\\npinned: true\\n---"}',
    ],
  ])("refuses %s", (_case, answer) => {
    expect(mergeOf(answer)).toBeNull();
  });
});
