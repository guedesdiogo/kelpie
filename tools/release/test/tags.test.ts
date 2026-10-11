import { describe, expect, it } from "vitest";
import {
  parseTag,
  parseTarget,
  pickTag,
  previousTag,
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

  it("finds a build, a tag and a commit, by prefix either way", () => {
    expect(pickTag(versions, { kind: "build", build: 93 })?.commit).toBe("37c5f21");
    expect(pickTag(versions, { kind: "tag", tag: { build: 94, commit: "cc8e179" } })?.build).toBe(
      94,
    );
    expect(pickTag(versions, { kind: "commit", commit: "37c5f21aa" })?.build).toBe(93);
  });

  it("answers null when nothing matches", () => {
    expect(pickTag(versions, { kind: "build", build: 50 })).toBeNull();
  });
});

describe("previousTag", () => {
  const versions = [
    version("v101", 4, "101-aaaaaaa"),
    version("v100", 3, "100-bbbbbbb"),
    version("v99", 2, "99-ccccccc"),
  ];
  const deployment = (...traffic: Array<[string, number]>) => ({
    versions: traffic.map(([version_id, percentage]) => ({ version_id, percentage })),
  });
  const live = { build: 101, commit: "aaaaaaa" };

  it("takes the build served before the live one, not the highest build below it", () => {
    // 100 deployed, was rolled back to 99, then 101 deployed.
    const history = [
      deployment(["v101", 100]),
      deployment(["v99", 100]),
      deployment(["v100", 100]),
    ];
    expect(previousTag(history, versions, live)).toEqual({ build: 99, commit: "ccccccc" });
  });

  it("skips deployments of the live build and versions it can't name", () => {
    const history = [
      deployment(["v101", 100]),
      deployment(["v101", 100]),
      deployment(["gone", 100]),
      deployment(["v100", 90], ["v99", 10]),
    ];
    expect(previousTag(history, versions, live)?.build).toBe(100);
  });

  it("answers null without an earlier build", () => {
    expect(previousTag([deployment(["v101", 100])], versions, live)).toBeNull();
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
