import { describe, expect, it } from "vitest";
import { hasConflictMarkers, mergeOwnerWins } from "../src/merge.ts";

const lines = (...text: string[]) => `${text.join("\n")}\n`;

describe("mergeOwnerWins", () => {
  const base = lines("# Ana", "", "Mora em Lisboa.", "", "Gosta de café.", "", "Tem um gato.");

  it("keeps both sides' changes where they don't overlap", () => {
    const owner = lines("# Ana", "", "Mora no Porto.", "", "Gosta de café.", "", "Tem um gato.");
    const kelpie = lines(
      "# Ana",
      "",
      "Mora em Lisboa.",
      "",
      "Gosta de café.",
      "",
      "Tem dois gatos.",
    );
    expect(mergeOwnerWins(base, owner, kelpie)).toEqual({
      content: lines("# Ana", "", "Mora no Porto.", "", "Gosta de café.", "", "Tem dois gatos."),
      overlapped: false,
    });
  });

  it("takes the owner's side where they overlap, and keeps Kelpie's other changes", () => {
    const owner = lines("# Ana", "", "Mora no Porto.", "", "Gosta de café.", "", "Tem um gato.");
    const kelpie = lines("# Ana", "", "Mora em Braga.", "", "Gosta de chá.", "", "Tem um gato.");
    // Kelpie's line 5 is next to nothing the owner touched, so it stays.
    expect(mergeOwnerWins(base, owner, kelpie)).toEqual({
      content: lines("# Ana", "", "Mora no Porto.", "", "Gosta de chá.", "", "Tem um gato."),
      overlapped: true,
    });
  });

  it("sees the same change on both sides as no overlap", () => {
    const both = lines("# Ana", "", "Mora no Porto.", "", "Gosta de café.", "", "Tem um gato.");
    expect(mergeOwnerWins(base, both, both)).toEqual({ content: both, overlapped: false });
  });

  it("keeps lines Kelpie appended after the owner's edit", () => {
    const owner = base.replace("café", "café forte");
    const kelpie = `${base}\nFaz anos em maio.\n`;
    expect(mergeOwnerWins(base, owner, kelpie)).toEqual({
      content: `${owner}\nFaz anos em maio.\n`,
      overlapped: false,
    });
  });
});

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
  ])("ignores %s", (_name, text) => {
    expect(hasConflictMarkers(text)).toBe(false);
  });
});
