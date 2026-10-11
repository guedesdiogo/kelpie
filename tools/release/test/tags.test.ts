import { describe, expect, it } from "vitest";
import {
  parseTag,
  parseTarget,
  pickTag,
  sameTag,
  type TaggedVersion,
  versionWithTag,
} from "../src/tags.ts";

const version = (id: string, number: number, tag: string): TaggedVersion => ({
  id,
  number,
  tag: parseTag(tag) as NonNullable<ReturnType<typeof parseTag>>,
});

describe("parseTag", () => {
  it("reads a deploy's build and commit", () => {
    expect(parseTag("95-25c5076")).toEqual({ build: 95, commit: "25c5076" });
  });

  it.each([undefined, "", "25c5076", "95-xyz1234", "95-25c50"])("refuses %s", (tag) => {
    expect(parseTag(tag)).toBeNull();
  });
});

describe("parseTarget", () => {
  it.each([
    ["previous", { kind: "previous" }],
    [" Previous ", { kind: "previous" }],
    ["94", { kind: "build", build: 94 }],
    ["94-cc8e179", { kind: "tag", tag: { build: 94, commit: "cc8e179" } }],
    ["cc8e179", { kind: "commit", commit: "cc8e179" }],
    ["CC8E1791234", { kind: "commit", commit: "cc8e1791234" }],
  ])("reads %s", (input, target) => {
    expect(parseTarget(input)).toEqual(target);
  });

  it.each(["", "latest", "v94", "cc8e"])("refuses %s", (input) => {
    expect(parseTarget(input)).toBeNull();
  });
});

describe("pickTag", () => {
  const versions = [
    version("a", 20, "95-25c5076"),
    version("b", 19, "94-cc8e179"),
    version("c", 18, "93-37c5f21"),
    version("d", 17, "93-37c5f21"),
  ];
  const live = { build: 95, commit: "25c5076" };

  it("takes the newest build before the live one for previous", () => {
    expect(pickTag(versions, { kind: "previous" }, live)).toEqual({ build: 94, commit: "cc8e179" });
  });

  it("can't take previous without a live build", () => {
    expect(pickTag(versions, { kind: "previous" }, null)).toBeNull();
  });

  it("finds a build, a tag and a commit, by prefix either way", () => {
    expect(pickTag(versions, { kind: "build", build: 93 }, live)?.commit).toBe("37c5f21");
    expect(
      pickTag(versions, { kind: "tag", tag: { build: 94, commit: "cc8e179" } }, live)?.build,
    ).toBe(94);
    expect(pickTag(versions, { kind: "commit", commit: "37c5f21aa" }, live)?.build).toBe(93);
  });

  it("answers null when nothing matches", () => {
    expect(pickTag(versions, { kind: "build", build: 50 }, live)).toBeNull();
  });
});

describe("versionWithTag", () => {
  it("takes the newest upload of a tag", () => {
    const versions = [version("old", 17, "93-37c5f21"), version("new", 18, "93-37c5f21")];
    expect(versionWithTag(versions, { build: 93, commit: "37c5f21" })?.id).toBe("new");
  });

  it("needs the same build and commit", () => {
    expect(sameTag({ build: 93, commit: "37c5f21" }, { build: 94, commit: "37c5f21" })).toBe(false);
    expect(sameTag(null, { build: 94, commit: "37c5f21" })).toBe(false);
  });
});
