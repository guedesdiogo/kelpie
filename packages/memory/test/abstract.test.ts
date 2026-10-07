import { describe, expect, it } from "vitest";
import {
  abstractInput,
  abstractOf,
  type MemoryInput,
  withAbstract,
  writeMemory,
} from "../src/index.ts";

describe("abstractOf", () => {
  it("takes one line under one key, fenced or not", () => {
    expect(abstractOf('{"abstract": "Conversa sobre café."}')).toBe("Conversa sobre café.");
    expect(abstractOf('```json\n{"abstract": " Café. "}\n```')).toBe("Café.");
  });

  it.each([
    ["not JSON", "Conversa sobre café."],
    ["an array", '["Café."]'],
    ["another key too", '{"abstract": "Café.", "why": "x"}'],
    ["another key only", '{"summary": "Café."}'],
    ["a number", '{"abstract": 42}'],
    ["a blank line", '{"abstract": "  "}'],
    ["two lines", '{"abstract": "Café.\\nChá."}'],
    ["a bidirectional override", '{"abstract": "Café \\u202e."}'],
    ["past the writer's limit", JSON.stringify({ abstract: "a".repeat(301) })],
  ])("refuses %s", (_case, answer) => {
    expect(abstractOf(answer)).toBeNull();
  });
});

describe("abstractInput", () => {
  it("marks where the note starts and ends, cut at 6,000 characters", () => {
    const text = abstractInput({ path: "memory/notes/x.md", title: "X", body: "a".repeat(7_000) });
    expect(text).toContain("BEGIN NOTE\n");
    expect(text.endsWith("\nEND NOTE\n\nAnswer with the JSON only.")).toBe(true);
    expect(text.length).toBeLessThan(6_200);
  });
});

describe("withAbstract", () => {
  const memory = {
    scope: "global",
    kind: "session",
    title: "Conversa sobre café",
    body: "- **10:00 u-owner:** quero café",
    level: "explicit",
    confidence: 0.9,
    sources: ["telegram/chat-1, 2026-10-06"],
  } satisfies MemoryInput;

  it("changes the abstract line and leaves every other byte alone", async () => {
    const { text } = await writeMemory(
      { ...memory, abstract: "quero café" },
      { at: "2026-10-06T10:00:00Z" },
    );
    const next = withAbstract(text, "Conversa: café sem açúcar.");
    // Quoted as YAML needs, as the writer would.
    expect(next).toBe(
      text.replace("abstract: quero café", 'abstract: "Conversa: café sem açúcar."'),
    );
  });

  it("adds one to a note without, and nothing else changes", async () => {
    const { text } = await writeMemory(memory, { at: "2026-10-06T10:00:00Z" });
    const next = withAbstract(text, "Café.") ?? "";
    expect(next.replace("abstract: Café.\n", "")).toBe(text);
  });

  it("is null for a file whose frontmatter can't be read", () => {
    expect(withAbstract("# Sem frontmatter\n", "X.")).toBeNull();
    expect(withAbstract("---\na: [\n---\n# X\n", "X.")).toBeNull();
  });
});
