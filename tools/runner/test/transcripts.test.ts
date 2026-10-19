import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listNames } from "../src/files.ts";
import { MAX_TRANSCRIPT_TAIL_BYTES, prLinkOf, transcriptFinder } from "../src/transcripts.ts";
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

const transcriptOf = (claudeDir: string, id: string, cwd: string | null) =>
  transcriptFinder(claudeDir)(id, cwd);

describe("transcriptFinder", () => {
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

  it("indexes the project folders once for all the sessions it looks up, and only when it must", () => {
    const paths = [SESSION_A, SESSION_B].map((id) =>
      writeTranscript(vps, id, `/elsewhere/${id}`, []),
    );
    let listed = 0;
    const counting: typeof listNames = (dir, max, filesOnly) => {
      if (dir === join(vps.claudeDir, "projects")) listed += 1;
      return listNames(dir, max, filesOnly);
    };
    const find = transcriptFinder(vps.claudeDir, counting);
    expect(find(SESSION_A, `/elsewhere/${SESSION_A}`)).toBe(paths[0]);
    expect(listed).toBe(0);
    expect(find(SESSION_A, CWD)).toBe(paths[0]);
    expect(find(SESSION_B, CWD)).toBe(paths[1]);
    expect(find("cccccccc-1111-4222-8333-444444444444", CWD)).toBeNull();
    expect(listed).toBe(1);
  });

  it("finds 200 sessions' transcripts among 1,000 project folders, the first lookup paying for all", () => {
    const ids = Array.from(
      { length: 200 },
      (_, index) => `${String(index).padStart(8, "0")}-1111-4222-8333-444444444444`,
    );
    for (let folder = 0; folder < 1_000; folder += 1) {
      const dir = join(vps.claudeDir, "projects", `-folder-${folder}`);
      mkdirSync(dir);
      const id = ids[folder % 200] as string;
      if (folder >= 800) writeFileSync(join(dir, `${id}.jsonl`), "");
      else writeFileSync(join(dir, "notes.txt"), "");
    }
    // The best of three runs, each with a new finder, so a pause of the collector doesn't count.
    let first = Number.POSITIVE_INFINITY;
    let rest = Number.POSITIVE_INFINITY;
    let found: (string | null)[] = [];
    for (let run = 0; run < 3; run += 1) {
      const find = transcriptFinder(vps.claudeDir);
      const lookUp = (id: string) => find(id, `/nowhere/${id}`);
      let started = performance.now();
      found = ids.slice(0, 1).map(lookUp);
      first = Math.min(first, performance.now() - started);
      started = performance.now();
      found.push(...ids.slice(1).map(lookUp));
      rest = Math.min(rest, performance.now() - started);
    }
    // The first lookup reads the 1,000 folders into the index, and the other 199 cost about a
    // tenth of it, under coverage too. Scanning the folders on each lookup made them cost 95 to 216
    // times as much. The bound sits far from both, a ratio holds on a slow CI runner where a fixed
    // bound didn't, and the floor keeps a fast first lookup from turning noise into a failure.
    expect(rest / Math.max(first, 5)).toBeLessThan(4);
    expect(found.every((path) => path?.endsWith(".jsonl"))).toBe(true);
  });

  it("takes the first folder's transcript when two hold one for the session", () => {
    for (const folder of ["-first", "-second"]) {
      mkdirSync(join(vps.claudeDir, "projects", folder));
      writeFileSync(join(vps.claudeDir, "projects", folder, `${SESSION_A}.jsonl`), "");
    }
    expect(transcriptOf(vps.claudeDir, SESSION_A, CWD)).toMatch(/-(?:first|second)\/[^/]+\.jsonl$/);
  });

  it("leaves out a folder's entry that isn't a transcript", () => {
    const dir = join(vps.claudeDir, "projects", "-odd");
    mkdirSync(join(dir, `${SESSION_A}.jsonl`), { recursive: true });
    writeFileSync(join(dir, "README.jsonl"), "");
    // A file where a project folder would be.
    writeFileSync(join(vps.claudeDir, "projects", `${SESSION_A}.jsonl`), "");
    expect(transcriptOf(vps.claudeDir, SESSION_A, CWD)).toBeNull();
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
