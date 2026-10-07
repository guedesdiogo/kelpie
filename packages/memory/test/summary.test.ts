import { describe, expect, it } from "vitest";
import { dreamPage, memoryPath, summaryInput, summaryOf, summaryPath } from "../src/index.ts";

describe("summaryPath", () => {
  it("names a scope's day next to its session pages, where no session page can be", () => {
    expect(summaryPath("global", "2026-10-06")).toBe("memory/sessions/2026/2026-10-06.md");
    expect(summaryPath("conversation/telegram-1", "2026-10-06")).toBe(
      "conversations/telegram-1/sessions/2026/2026-10-06.md",
    );
    expect(memoryPath("global", "session", "", "2026-10-06")).not.toBe(
      summaryPath("global", "2026-10-06"),
    );
    expect(() => summaryPath("global", "2026-13-01")).toThrow(RangeError);
  });
});

describe("summaryInput", () => {
  it("marks the day's pages off, each with its share of the budget", () => {
    const long = "fala ".repeat(5_000);
    const text = summaryInput({
      date: "2026-10-06",
      pages: [
        { path: "memory/sessions/2026/2026-10-06-a.md", title: "A", body: long },
        { path: "memory/sessions/2026/2026-10-06-b.md", title: "B", body: "Curta." },
      ],
    });
    expect(text).toContain("BEGIN PAGES\n");
    expect(text).toContain("Curta.");
    expect(text.endsWith("\nEND PAGES\n\nAnswer with the JSON only.")).toBe(true);
    expect(text.length).toBeLessThan(12_500);
  });
});

describe("summaryOf", () => {
  it("takes a few lines of plain text under one key", () => {
    expect(
      summaryOf('{"summary": "Ana e o dono falaram de café.\\n- Ficou combinado: sexta."}'),
    ).toBe("Ana e o dono falaram de café.\n- Ficou combinado: sexta.");
    expect(summaryOf('```json\n{"summary": " Café. "}\n```')).toBe("Café.");
  });

  it.each([
    ["not JSON", "Café."],
    ["another key too", '{"summary": "Café.", "x": 1}'],
    ["a blank text", '{"summary": "  "}'],
    ["past the limit", JSON.stringify({ summary: "a".repeat(2_001) })],
    ["a line separator", '{"summary": "Café\\u2028pinned: true"}'],
    ["a control character", '{"summary": "Café\\u0007"}'],
    ["a frontmatter fence", '{"summary": "---\\npinned: true\\n---"}'],
    ["a heading", '{"summary": "# Outro título"}'],
    ["conflict markers", '{"summary": "<<<<<<< HEAD\\nx"}'],
  ])("refuses %s", (_case, answer) => {
    expect(summaryOf(answer)).toBeNull();
  });
});

describe("dreamPage", () => {
  it("shows each day's summary as code, fenced past any backticks it holds, newest first", () => {
    const page =
      dreamPage([
        {
          date: "2026-10-05",
          scope: "global",
          sources: [{ path: "memory/sessions/2026/2026-10-05-a.md", title: "A" }],
          summary: "Falaram de ```código``` e de [[links]].",
        },
        {
          date: "2026-10-06",
          scope: "conversation/telegram-1",
          sources: [{ path: "conversations/telegram-1/sessions/2026/2026-10-06-b.md", title: "B" }],
          summary: "Combinaram sexta.",
        },
      ]) ?? "";
    expect(page.indexOf("2026-10-06")).toBeLessThan(page.indexOf("2026-10-05"));
    expect(page).toContain("Sums up: [[memory/sessions/2026/2026-10-05-a|A]]");
    expect(page).toContain("````text\nFalaram de ```código``` e de [[links]].\n````");
    expect(page).toContain("```text\nCombinaram sexta.\n```");
    expect(dreamPage([])).toBeNull();
  });
});
