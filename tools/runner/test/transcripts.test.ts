import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_TRANSCRIPT_TAIL_BYTES, prLinkOf, transcriptOf } from "../src/transcripts.ts";
import {
  type FakeVps,
  fakeVps,
  prLink,
  SESSION_A,
  SESSION_B,
  writeTranscript,
} from "./fake-vps.ts";

const CWD = "/home/owner/Repos/kelpie/.claude/worktrees/runner";
const PR = "https://github.com/guedesdiogo/kelpie/pull/433";

let vps: FakeVps;
beforeEach(() => {
  vps = fakeVps();
});
afterEach(() => vps.cleanup());

/** A message line, as a transcript holds them: never read for the link. */
const message = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

describe("transcriptOf", () => {
  it("finds a transcript in the folder Claude Code names after the working folder", () => {
    const path = writeTranscript(vps, SESSION_A, CWD, [message("Hi")]);
    expect(path).toContain("-home-owner-Repos-kelpie--claude-worktrees-runner");
    expect(transcriptOf(vps.claudeDir, SESSION_A, CWD)).toBe(path);
  });

  it("looks through the project folders when it isn't there", () => {
    const path = writeTranscript(vps, SESSION_A, "/elsewhere", [message("Hi")]);
    mkdirSync(join(vps.claudeDir, "projects", "empty"));
    expect(transcriptOf(vps.claudeDir, SESSION_A, CWD)).toBe(path);
    expect(transcriptOf(vps.claudeDir, SESSION_A, null)).toBe(path);
  });

  it("finds none for a session without one, or an id that isn't a UUID", () => {
    writeTranscript(vps, SESSION_A, CWD, [message("Hi")]);
    expect(transcriptOf(vps.claudeDir, SESSION_B, CWD)).toBeNull();
    expect(transcriptOf(vps.claudeDir, "../x", CWD)).toBeNull();
    expect(transcriptOf(join(vps.root, "missing"), SESSION_A, CWD)).toBeNull();
  });
});

describe("prLinkOf", () => {
  it("takes the last pull request link", () => {
    const path = writeTranscript(vps, SESSION_A, CWD, [
      prLink("https://github.com/guedesdiogo/kelpie/pull/431"),
      message("Opened."),
      prLink(PR),
      message("Reviewed."),
    ]);
    expect(prLinkOf(path)).toBe(PR);
  });

  it.each([
    ["an address that isn't GitHub's", "https://evil.example/guedesdiogo/kelpie/pull/1"],
    ["an issue's address", "https://github.com/guedesdiogo/kelpie/issues/433"],
    ["an address with more after it", `${PR}/files`],
    ["a link that isn't one", "javascript:alert(1)"],
  ])("shows none for %s", (_, url) => {
    const path = writeTranscript(vps, SESSION_A, CWD, [prLink(url)]);
    expect(prLinkOf(path)).toBeNull();
  });

  it("reads only pr-link entries, never a message that quotes one", () => {
    const quoted = JSON.stringify(prLink(PR));
    const path = writeTranscript(vps, SESSION_A, CWD, [
      message(quoted),
      { message: "x", ...prLink(PR) },
      { ...prLink(PR), type: "summary" },
    ]);
    // A line whose `type` comes first but is overridden later isn't one either.
    appendFileSync(path, `{"type":"pr-link","type":"summary","prUrl":"${PR}"}\n`);
    appendFileSync(path, `{"type":"pr-link","prUrl":"${PR}"\n`);
    appendFileSync(path, `{"type":"pr-link","prUrl":"${PR}","pad":"${"x".repeat(5_000)}"}\n`);
    appendFileSync(path, `{"type":"pr-link","prUrl":7}\n`);
    expect(prLinkOf(path)).toBeNull();
  });

  it("reads only the last 1 MiB: a link written before it shows as none", () => {
    const path = writeTranscript(vps, SESSION_A, CWD, [prLink(PR)]);
    appendFileSync(path, `${JSON.stringify(message("x".repeat(MAX_TRANSCRIPT_TAIL_BYTES)))}\n`);
    expect(prLinkOf(path)).toBeNull();
    appendFileSync(path, `${JSON.stringify(prLink(PR))}\n`);
    expect(prLinkOf(path)).toBe(PR);
  });

  it("shows none for a transcript it can't read", () => {
    expect(prLinkOf(join(vps.root, "missing.jsonl"))).toBeNull();
    writeFileSync(join(vps.root, "empty.jsonl"), "");
    expect(prLinkOf(join(vps.root, "empty.jsonl"))).toBeNull();
  });
});
