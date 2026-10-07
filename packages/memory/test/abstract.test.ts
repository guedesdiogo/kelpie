import { describe, expect, it } from "vitest";
import { abstractInput, abstractOf } from "../src/index.ts";

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
