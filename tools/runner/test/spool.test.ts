import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPrivateDir } from "../src/files.ts";
import { ownUid } from "../src/secrets.ts";
import {
  appendEvent,
  deleteExcerpt,
  deleteRequest,
  deleteSocket,
  EVENTS_FILE,
  listActions,
  listExcerpts,
  MAX_EVENTS_FILE_BYTES,
  MAX_EXCERPT_FILE_BYTES,
  OLDER_EVENTS_FILE,
  parseSpoolLine,
  prepareSpoolDir,
  readEvents,
  readExcerpt,
  readRequest,
  readSocket,
  readVerdict,
  type SpoolEvent,
  type SpoolRequest,
  spoolDirOf,
  takeVerdict,
  writeExcerpt,
  writeRequest,
  writeSocket,
  writeVerdict,
} from "../src/spool.ts";
import { NOW, SESSION_A, SESSION_B, spoolEvent } from "./fake-vps.ts";

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kelpie-runner-spool-"));
  dir = join(root, "state", "session-events");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe("the spool's directory", () => {
  it("lives under the owner's home", () => {
    expect(spoolDirOf("/home/owner")).toBe("/home/owner/.local/state/kelpie-runner/session-events");
  });

  it("is made 0700, with its parents, or taken as it is when private", () => {
    expect(prepareSpoolDir(dir, ownUid())).toBe(true);
    expect(mode(dir)).toBe(0o700);
    expect(prepareSpoolDir(dir, ownUid())).toBe(true);
  });

  it.each([0o750, 0o705])("is refused when others may open it (mode %o)", (bits) => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, bits);
    expect(prepareSpoolDir(dir, ownUid())).toBe(false);
  });

  it("isn't private when it isn't there", () => {
    expect(isPrivateDir(join(root, "missing"), ownUid())).toBe(false);
  });

  it("is refused when it belongs to another user, is a symlink, or is a file", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect(prepareSpoolDir(dir, ownUid() + 1)).toBe(false);
    const link = join(root, "link");
    symlinkSync(dir, link);
    expect(prepareSpoolDir(link, ownUid())).toBe(false);
    const file = join(root, "file");
    writeFileSync(file, "");
    expect(prepareSpoolDir(file, ownUid())).toBe(false);
    expect(prepareSpoolDir(join(file, "inner"), ownUid())).toBe(false);
  });
});

describe("the spool's events", () => {
  beforeEach(() => {
    prepareSpoolDir(dir, ownUid());
  });

  it("appends one line per event, to a file only the owner may read", () => {
    const first = spoolEvent("PermissionRequest", NOW, { question: true });
    const second = spoolEvent("Notification", NOW + 6_000, { type: "permission_prompt" });
    appendEvent(dir, first);
    appendEvent(dir, second);
    const path = join(dir, EVENTS_FILE);
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    );
    expect(readEvents(dir)).toEqual([first, second]);
  });

  it("rotates a full file, keeping at most 1 MiB in all, and reads the older file first", () => {
    const line = (at: number) => `${JSON.stringify(spoolEvent("Stop", at))}\n`;
    const size = line(NOW).length;
    const full = Math.floor(MAX_EVENTS_FILE_BYTES / size);
    writeFileSync(join(dir, OLDER_EVENTS_FILE), line(NOW - 1));
    writeFileSync(
      join(dir, EVENTS_FILE),
      Array.from({ length: full }, (_, index) => line(NOW + index)).join(""),
      { mode: 0o600 },
    );
    appendEvent(dir, spoolEvent("Stop", NOW + full));
    expect(statSync(join(dir, OLDER_EVENTS_FILE)).size).toBe(full * size);
    expect(statSync(join(dir, EVENTS_FILE)).size).toBe(size);
    const events = readEvents(dir);
    expect(events).toHaveLength(full + 1);
    expect(events.map((event) => event.at)).toEqual(
      Array.from({ length: full + 1 }, (_, index) => NOW + index),
    );
    expect(full * size + size).toBeLessThanOrEqual(2 * MAX_EVENTS_FILE_BYTES);
  });

  it("skips the lines that don't parse", () => {
    writeFileSync(join(dir, EVENTS_FILE), "not json\n{}\n[1]\n", { mode: 0o600 });
    appendEvent(dir, spoolEvent("Stop", NOW));
    expect(readEvents(dir)).toEqual([spoolEvent("Stop", NOW)]);
  });

  it("reads only a file's last part when it grew past its bound, from its next whole line", () => {
    const line = `${JSON.stringify(spoolEvent("UserPromptSubmit", NOW))}\n`;
    const count = Math.ceil((MAX_EVENTS_FILE_BYTES + 128 * 1024) / line.length);
    writeFileSync(join(dir, EVENTS_FILE), line.repeat(count), { mode: 0o600 });
    const events = readEvents(dir);
    expect(events.length).toBeLessThan(count);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.event === "UserPromptSubmit")).toBe(true);
  });

  it("reads no events from a spool not there yet", () => {
    expect(readEvents(join(root, "missing"))).toEqual([]);
  });
});

describe("parseSpoolLine", () => {
  const valid: SpoolEvent = { at: NOW, event: "SessionEnd", session: SESSION_A, reason: "other" };

  it("takes a line the hook wrote", () => {
    expect(parseSpoolLine(JSON.stringify(valid))).toEqual(valid);
    const question = { at: NOW, event: "PermissionRequest", session: SESSION_A, question: true };
    expect(parseSpoolLine(JSON.stringify(question))).toEqual(question);
    const prompt = { at: NOW, event: "Notification", session: SESSION_A, type: "idle_prompt" };
    expect(parseSpoolLine(JSON.stringify(prompt))).toEqual(prompt);
  });

  it("drops a type, a reason or a question that isn't one", () => {
    const line = { ...valid, type: "Bad Type", reason: "x".repeat(65), question: "yes" };
    expect(parseSpoolLine(JSON.stringify(line))).toEqual({
      at: NOW,
      event: "SessionEnd",
      session: SESSION_A,
    });
  });

  it("takes a subagent's id, or a subagent of unknown id, and reads a line with neither as the main thread's", () => {
    // A line from before #482, as the main thread's line still is.
    const main = { at: NOW, event: "PostToolUse", session: SESSION_A };
    const subagent = { ...main, agent: "a1b2c3d4e5f6a7b8" };
    const unknown = { ...main, agent: null };
    expect(parseSpoolLine(JSON.stringify(subagent))).toStrictEqual(subagent);
    expect(parseSpoolLine(JSON.stringify(unknown))).toStrictEqual(unknown);
    expect(parseSpoolLine(JSON.stringify(main))).toStrictEqual(main);
  });

  it.each([
    ["too long", "a".repeat(65)],
    ["empty", ""],
    ["with odd characters", "a b/c"],
    ["a number", 7],
    ["true", true],
  ])(
    "reads a subagent's id that isn't a short token, %s, as a subagent of unknown id",
    (_, agent) => {
      const line = { at: NOW, event: "PostToolUse", session: SESSION_A, agent };
      expect(parseSpoolLine(JSON.stringify(line))).toStrictEqual({ ...line, agent: null });
    },
  );

  it.each([
    ["not JSON", "{"],
    ["null", "null"],
    ["a list", "[]"],
    ["a time that isn't one", JSON.stringify({ ...valid, at: -1 })],
    ["a fractional time", JSON.stringify({ ...valid, at: 1.5 })],
    ["another event", JSON.stringify({ ...valid, event: "PreToolUse" })],
    ["a session id that isn't a UUID", JSON.stringify({ ...valid, session: "../../etc" })],
    ["an uppercase session id", JSON.stringify({ ...valid, session: SESSION_A.toUpperCase() })],
    ["no session id", JSON.stringify({ at: NOW, event: "Stop" })],
  ])("refuses %s", (_, line) => {
    expect(parseSpoolLine(line)).toBeNull();
  });
});

describe("the spool's excerpts", () => {
  beforeEach(() => {
    prepareSpoolDir(dir, ownUid());
  });

  it("keeps only each session's latest excerpt, in a file only the owner may read", () => {
    writeExcerpt(dir, SESSION_A, { at: NOW, text: "First." });
    writeExcerpt(dir, SESSION_A, { at: NOW + 1, text: "Second." });
    writeExcerpt(dir, SESSION_B, { at: NOW, text: "Other." });
    expect(readExcerpt(dir, SESSION_A)).toEqual({ at: NOW + 1, text: "Second." });
    expect(mode(join(dir, `excerpt-${SESSION_A}.json`))).toBe(0o600);
    expect(listExcerpts(dir).sessions.sort()).toEqual([SESSION_A, SESSION_B]);
    deleteExcerpt(dir, SESSION_A);
    deleteExcerpt(dir, SESSION_A);
    expect(readExcerpt(dir, SESSION_A)).toBeNull();
    expect(listExcerpts(dir)).toEqual({ sessions: [SESSION_B], temporary: [] });
  });

  it("uses a session id in a path only once it is a UUID", () => {
    writeExcerpt(dir, "../escape", { at: NOW, text: "x" });
    deleteExcerpt(dir, "../escape");
    expect(readExcerpt(dir, "../escape")).toBeNull();
    expect(listExcerpts(dir)).toEqual({ sessions: [], temporary: [] });
  });

  it.each([
    ["isn't JSON", "{"],
    ["is null", "null"],
    ["has no time", JSON.stringify({ text: "x" })],
    ["has no text", JSON.stringify({ at: NOW })],
    ["is too large", JSON.stringify({ at: NOW, text: "x".repeat(MAX_EXCERPT_FILE_BYTES) })],
  ])("reads no excerpt from a file that %s", (_, content) => {
    writeFileSync(join(dir, `excerpt-${SESSION_A}.json`), content);
    expect(readExcerpt(dir, SESSION_A)).toBeNull();
  });

  it("lists leftover temporary files apart, and ignores anything else", () => {
    writeFileSync(join(dir, `.excerpt-${SESSION_A}.123.tmp`), "");
    writeFileSync(join(dir, "excerpt-not-a-uuid-at-all-but-36-chars-long.json"), "");
    writeFileSync(join(dir, `excerpt-${"a".repeat(36)}.json`), "");
    writeFileSync(join(dir, "notes.txt"), "");
    expect(listExcerpts(dir)).toEqual({
      sessions: [],
      temporary: [`.excerpt-${SESSION_A}.123.tmp`],
    });
    expect(listExcerpts(join(root, "missing"))).toEqual({ sessions: [], temporary: [] });
  });
});

const REQUEST_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const REQUEST_B = "bbbbbbbb-0000-4000-8000-00000000000b";

function spoolRequest(overrides: Partial<SpoolRequest> = {}): SpoolRequest {
  return {
    id: REQUEST_A,
    session: SESSION_A,
    at: NOW,
    deadline: NOW + 570_000,
    pid: 4242,
    tool: "Bash",
    input: "rm -rf build",
    whole: true,
    ...overrides,
  };
}

describe("the spool's permission requests (ADR-0069 §1)", () => {
  beforeEach(() => {
    prepareSpoolDir(dir, ownUid());
  });

  it("keeps each request in a file of its own, only the owner may read, until it is deleted", () => {
    writeRequest(dir, spoolRequest());
    writeRequest(dir, spoolRequest({ id: REQUEST_B, session: SESSION_B, agent: "a1b2c3" }));
    expect(readRequest(dir, REQUEST_A)).toEqual(spoolRequest());
    expect(readRequest(dir, REQUEST_B)).toEqual(
      spoolRequest({ id: REQUEST_B, session: SESSION_B, agent: "a1b2c3" }),
    );
    expect(mode(join(dir, `request-${REQUEST_A}.json`))).toBe(0o600);
    expect(listActions(dir).requests.sort()).toEqual([REQUEST_A, REQUEST_B]);
    deleteRequest(dir, REQUEST_A);
    deleteRequest(dir, REQUEST_A);
    expect(readRequest(dir, REQUEST_A)).toBeNull();
    expect(listActions(dir).requests).toEqual([REQUEST_B]);
  });

  it("reads a request that doesn't say it is whole as cut short", () => {
    writeFileSync(
      join(dir, `request-${REQUEST_A}.json`),
      JSON.stringify({ ...spoolRequest(), whole: undefined }),
    );
    expect(readRequest(dir, REQUEST_A)?.whole).toBe(false);
  });

  it("keeps a subagent of unknown id as null, and the main thread's without one", () => {
    writeRequest(dir, spoolRequest({ agent: null }));
    expect(readRequest(dir, REQUEST_A)?.agent).toBeNull();
    writeRequest(dir, spoolRequest());
    expect(readRequest(dir, REQUEST_A)).not.toHaveProperty("agent");
  });

  it.each([
    ["isn't JSON", "{"],
    ["has another id", JSON.stringify(spoolRequest({ id: REQUEST_B }))],
    ["has a session that isn't a UUID", JSON.stringify(spoolRequest({ session: "x" }))],
    ["has no deadline", JSON.stringify({ ...spoolRequest(), deadline: undefined })],
    ["has a pid that isn't one", JSON.stringify(spoolRequest({ pid: 0 }))],
    ["has a tool that isn't a name", JSON.stringify(spoolRequest({ tool: "rm -rf" }))],
    ["has an input that isn't text", JSON.stringify({ ...spoolRequest(), input: 5 })],
    ["has an agent that isn't a token", JSON.stringify(spoolRequest({ agent: "a b" }))],
    ["is too large", JSON.stringify(spoolRequest({ input: "x".repeat(20_000) }))],
  ])("reads no request from a file that %s", (_, content) => {
    writeFileSync(join(dir, `request-${REQUEST_A}.json`), content);
    expect(readRequest(dir, REQUEST_A)).toBeNull();
  });

  it("uses a request id in a path only once it is a UUID", () => {
    writeRequest(dir, spoolRequest({ id: "../escape" }));
    expect(readRequest(dir, "../escape")).toBeNull();
    expect(writeVerdict(dir, { id: "../escape", behavior: "allow", at: NOW })).toBe(false);
    expect(takeVerdict(dir, "../escape")).toBe(false);
    deleteRequest(dir, "../escape");
    expect(listActions(dir)).toEqual({ requests: [], verdicts: [], sockets: [] });
  });
});

describe("the spool's verdicts", () => {
  beforeEach(() => {
    prepareSpoolDir(dir, ownUid());
  });

  it("takes one verdict per request, which only one taker removes", () => {
    expect(writeVerdict(dir, { id: REQUEST_A, behavior: "allow", at: NOW })).toBe(true);
    expect(writeVerdict(dir, { id: REQUEST_A, behavior: "deny", at: NOW + 1 })).toBe(false);
    expect(readVerdict(dir, REQUEST_A)).toEqual({ id: REQUEST_A, behavior: "allow", at: NOW });
    expect(mode(join(dir, `verdict-${REQUEST_A}.json`))).toBe(0o600);
    expect(listActions(dir).verdicts).toEqual([REQUEST_A]);
    expect(takeVerdict(dir, REQUEST_A)).toBe(true);
    expect(takeVerdict(dir, REQUEST_A)).toBe(false);
    expect(readVerdict(dir, REQUEST_A)).toBeNull();
  });

  it("never writes through a symlink in a verdict's place", () => {
    const target = join(root, "elsewhere");
    symlinkSync(target, join(dir, `verdict-${REQUEST_A}.json`));
    expect(writeVerdict(dir, { id: REQUEST_A, behavior: "allow", at: NOW })).toBe(false);
    expect(() => statSync(target)).toThrow();
  });

  it.each([
    ["isn't JSON", "allow"],
    ["names another request", JSON.stringify({ id: REQUEST_B, behavior: "allow", at: NOW })],
    ["has another behavior", JSON.stringify({ id: REQUEST_A, behavior: "ask", at: NOW })],
    ["has no time", JSON.stringify({ id: REQUEST_A, behavior: "deny" })],
  ])("reads no verdict from a file that %s", (_, content) => {
    writeFileSync(join(dir, `verdict-${REQUEST_A}.json`), content);
    expect(readVerdict(dir, REQUEST_A)).toBeNull();
  });
});

describe("the spool's inbox addresses", () => {
  beforeEach(() => {
    prepareSpoolDir(dir, ownUid());
  });

  it("keeps each session's latest, in a file only the owner may read", () => {
    writeSocket(dir, SESSION_A, { at: NOW, path: "/run/user/1000/cc-socks/1.sock" });
    writeSocket(dir, SESSION_A, { at: NOW + 1, path: "/run/user/1000/cc-socks/2.sock" });
    expect(readSocket(dir, SESSION_A)).toEqual({
      at: NOW + 1,
      path: "/run/user/1000/cc-socks/2.sock",
    });
    expect(mode(join(dir, `socket-${SESSION_A}.json`))).toBe(0o600);
    expect(listActions(dir).sockets).toEqual([SESSION_A]);
    deleteSocket(dir, SESSION_A);
    expect(readSocket(dir, SESSION_A)).toBeNull();
  });

  it.each([
    ["a relative path", { at: NOW, path: "cc-socks/1.sock" }],
    ["no time", { path: "/run/user/1000/cc-socks/1.sock" }],
    ["a path too long", { at: NOW, path: `/${"s".repeat(300)}` }],
  ])("reads no address with %s", (_, value) => {
    writeFileSync(join(dir, `socket-${SESSION_A}.json`), JSON.stringify(value));
    expect(readSocket(dir, SESSION_A)).toBeNull();
  });

  it("writes none for a session id that isn't a UUID", () => {
    writeSocket(dir, "../escape", { at: NOW, path: "/tmp/x.sock" });
    expect(readSocket(dir, "../escape")).toBeNull();
    expect(listActions(dir).sockets).toEqual([]);
  });
});

describe("listActions", () => {
  it("lists nothing in a spool not there yet, and ignores what isn't the spool's", () => {
    expect(listActions(join(root, "missing"))).toEqual({ requests: [], verdicts: [], sockets: [] });
    prepareSpoolDir(dir, ownUid());
    writeFileSync(join(dir, "request-not-a-uuid.json"), "");
    writeFileSync(join(dir, `verdict-${"a".repeat(36)}.json`), "");
    writeFileSync(join(dir, `.request-${REQUEST_A}.12.tmp`), "");
    expect(listActions(dir)).toEqual({ requests: [], verdicts: [], sockets: [] });
    expect(listExcerpts(dir).temporary).toEqual([`.request-${REQUEST_A}.12.tmp`]);
  });
});
