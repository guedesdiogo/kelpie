import { describe, expect, it } from "vitest";
import { conflictsOf, hasConflictMarkers, keepsProvenance } from "../src/conflicts.ts";

describe("hasConflictMarkers", () => {
  it.each([
    ["git's markers", "a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> main\nb\n"],
    ["diff3's, with the base", "<<<<<<< ours\nx\n||||||| base\ny\n=======\nz\n>>>>>>> theirs"],
    ["Windows line ends", "<<<<<<< HEAD\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> main\r\n"],
  ])("finds %s", (_name, text) => {
    expect(hasConflictMarkers(text)).toBe(true);
  });

  it.each([
    ["a heading's underline", "Planos\n=======\n\nViajar.\n"],
    ["an unfinished block", "<<<<<<< HEAD\nmine\n=======\ntheirs\n"],
    ["markers out of order", ">>>>>>> main\n=======\n<<<<<<< HEAD\n"],
    ["markers inside a line", "see <<<<<<< HEAD and ======= and >>>>>>> main"],
    ["markers quoted in a code fence", "```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n```\n"],
    ["markers quoted in a tilde fence", "~~~\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n~~~\n"],
  ])("ignores %s", (_name, text) => {
    expect(hasConflictMarkers(text)).toBe(false);
  });

  it.each([
    ["after a fence left open", "```\ncode\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n"],
    [
      "inside a fence a shorter one can't close",
      "````\n```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n```\n",
    ],
  ])("finds a conflict %s", (_name, text) => {
    expect(hasConflictMarkers(text)).toBe(true);
  });

  it("reads a file in one pass, however its markers repeat", () => {
    const repeated = "<<<<<<<\n=======\n".repeat(32_000);
    const opened = "<<<<<<<\n".repeat(64_000);
    const started = performance.now();
    expect(hasConflictMarkers(repeated)).toBe(false);
    expect(hasConflictMarkers(opened)).toBe(false);
    // A backtracking regex took tens of seconds on these 512 KB.
    expect(performance.now() - started).toBeLessThan(1_000);
    // An unfinished block over a long file: its lines are kept one at a time.
    expect(hasConflictMarkers(`<<<<<<< HEAD\n${"\n".repeat(600_000)}`)).toBe(false);
  });
});

describe("keepsProvenance", () => {
  const marked = [
    "# Ana",
    "",
    "<<<<<<< HEAD",
    "Mora no Porto.",
    "=======",
    "Mora em Braga.",
    ">>>>>>> main",
    "",
    "Gosta de café.",
    "",
  ].join("\n");
  const conflicted = conflictsOf(marked);
  const keeps = (text: string) => conflicted !== null && keepsProvenance(conflicted, text);

  it.each([
    ["one side", "# Ana\n\nMora no Porto.\n\nGosta de café.\n"],
    ["both sides", "# Ana\n\nMora em Braga.\nMora no Porto.\n\nGosta de café.\n"],
    ["neither side", "# Ana\n\n\nGosta de café.\n"],
  ])("accepts %s", (_name, text) => {
    expect(keeps(text)).toBe(true);
  });

  it.each([
    ["an edited line", "# Ana\n\nMora no Porto, antes em Braga.\n\nGosta de café.\n"],
    ["a dropped line outside the conflict", "# Ana\n\nMora no Porto.\n"],
    ["a line added outside it", "# Ana\n\nMora no Porto.\n\nGosta de café.\npinned: true\n"],
    ["new frontmatter", "---\npinned: true\n---\n# Ana\n\nMora no Porto.\n\nGosta de café.\n"],
  ])("refuses %s", (_name, text) => {
    expect(keeps(text)).toBe(false);
  });

  it("tries every way to split the answer, not only the first", () => {
    const paragraphs = conflictsOf(
      "a\n<<<<<<< A\nx1\n\nx2\n=======\ny\n>>>>>>> B\n\n<<<<<<< A\np\n=======\nq\n>>>>>>> B\nz\n",
    );
    // A blank line inside the first conflict, before the blank line between the two.
    expect(paragraphs !== null && keepsProvenance(paragraphs, "a\nx1\n\nx2\n\np\nz\n")).toBe(true);
    const adjacent = conflictsOf(
      "a\n<<<<<<< A\n1\n=======\n2\n>>>>>>> B\n<<<<<<< A\n3\n=======\n4\n>>>>>>> B\nb",
    );
    expect(adjacent !== null && keepsProvenance(adjacent, "a\n1\n4\nb")).toBe(true);
    expect(adjacent !== null && keepsProvenance(adjacent, "a\nb")).toBe(true);
    expect(adjacent !== null && keepsProvenance(adjacent, "a\n3\n1\nb")).toBe(false);
  });

  it("takes a conflict's base lines, and checks each conflict between its neighbours", () => {
    const two = conflictsOf(
      "a\n<<<<<<< ours\nx\n||||||| base\ny\n=======\nz\n>>>>>>> theirs\nb\n<<<<<<< ours\n1\n=======\n2\n>>>>>>> theirs\nc",
    );
    expect(two?.blocks).toHaveLength(2);
    if (two === null) return;
    expect(keepsProvenance(two, "a\ny\nb\n2\nc")).toBe(true);
    // A line of the second conflict can't stand in the first.
    expect(keepsProvenance(two, "a\n2\nb\n1\nc")).toBe(false);
  });
});
