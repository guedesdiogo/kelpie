import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOOK_DEADLINE_MS,
  type HookOptions,
  MAX_INPUT_BYTES,
  readInput,
  recordEvent,
  runHook,
} from "../src/hook.ts";
import { MAX_EXCERPT_CHARS } from "../src/protocol.ts";
import { excerptOf, REDACTED, redact } from "../src/redact.ts";
import { ownUid } from "../src/secrets.ts";
import { EVENTS_FILE, readEvents, readExcerpt, spoolDirOf } from "../src/spool.ts";
import { NOW, RUNNER_SECRET, SESSION_A } from "./fake-vps.ts";

const HOOK = fileURLToPath(new URL("../hooks/session-event.ts", import.meta.url));

let root: string;
let options: HookOptions;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kelpie-runner-hook-"));
  options = { dir: join(root, "session-events"), now: NOW, uid: ownUid() };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A hook's input, as Claude Code sends it: the common fields, then the event's own. */
function input(event: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION_A,
    transcript_path: `/home/owner/.claude/projects/x/${SESSION_A}.jsonl`,
    cwd: "/home/owner/Repos/kelpie",
    permission_mode: "default",
    hook_event_name: event,
    ...fields,
  });
}

async function* chunks(...parts: (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> {
  yield* parts;
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

describe("recordEvent", () => {
  it.each([
    ["PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }, {}],
    ["PermissionRequest", { tool_name: "AskUserQuestion" }, { question: true }],
    [
      "Notification",
      { notification_type: "permission_prompt", message: "Claude needs" },
      {
        type: "permission_prompt",
      },
    ],
    ["Notification", { notification_type: "Not A Type" }, {}],
    ["PermissionDenied", { tool_name: "AskUserQuestion", reason: "denied" }, {}],
    ["PostToolUse", { tool_name: "Read", tool_response: { content: "secret file" } }, {}],
    ["PostToolUseFailure", { tool_name: "Bash", error: "boom" }, {}],
    ["UserPromptSubmit", { prompt: "deploy it" }, {}],
    ["StopFailure", { error: "rate_limit", last_assistant_message: "API Error" }, {}],
    ["SessionEnd", { reason: "prompt_input_exit" }, { reason: "prompt_input_exit" }],
  ])("writes %s's line, without its payload", (event, fields, extra) => {
    recordEvent(input(event, fields), options);
    expect(readEvents(options.dir)).toEqual([{ at: NOW, event, session: SESSION_A, ...extra }]);
    const line = readFileSync(join(options.dir, EVENTS_FILE), "utf8");
    for (const word of ["rm -rf", "secret file", "deploy it", "boom", "Claude needs", "/home/"]) {
      expect(line).not.toContain(word);
    }
  });

  it("makes its directory 0700 and its files 0600", () => {
    recordEvent(input("Stop", { last_assistant_message: "Done." }), options);
    expect(statSync(options.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(options.dir, EVENTS_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(options.dir, `excerpt-${SESSION_A}.json`)).mode & 0o777).toBe(0o600);
  });

  it("keeps Stop's reply redacted whole, then cut to 500 characters at a word", () => {
    const reply = `${"Updated the runner. ".repeat(20)}It used ${RUNNER_SECRET} and API_KEY=hunter2\n${"more words follow here ".repeat(5)}`;
    recordEvent(input("Stop", { last_assistant_message: reply }), options);
    const excerpt = readExcerpt(options.dir, SESSION_A);
    expect(excerpt).toEqual({ at: NOW, text: excerptOf(redact(reply), MAX_EXCERPT_CHARS) });
    expect(excerpt?.text.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(excerpt?.text).toContain(`It used ${REDACTED} and API_KEY=${REDACTED}`);
    expect(excerpt?.text).not.toContain("hunter2");
    expect(excerpt?.text).not.toContain(RUNNER_SECRET);
    expect(excerpt?.text).toMatch(/ (more|words|follow|here)$/);
  });

  it("drops a session's excerpt when its last reply has no text", () => {
    recordEvent(input("Stop", { last_assistant_message: "Older reply." }), options);
    recordEvent(input("Stop", { last_assistant_message: "  " }), options);
    expect(readExcerpt(options.dir, SESSION_A)).toBeNull();
    recordEvent(input("Stop", { last_assistant_message: "Older reply." }), options);
    recordEvent(input("Stop", {}), options);
    expect(readExcerpt(options.dir, SESSION_A)).toBeNull();
  });

  it("deletes the excerpt of a session that ends, but not on /clear or a resume", () => {
    const stop = input("Stop", { last_assistant_message: "Done." });
    for (const reason of ["clear", "resume"]) {
      recordEvent(stop, options);
      recordEvent(input("SessionEnd", { reason }), options);
      expect(readExcerpt(options.dir, SESSION_A)).not.toBeNull();
    }
    for (const fields of [{ reason: "other" }, { reason: "logout" }, {}]) {
      recordEvent(stop, options);
      recordEvent(input("SessionEnd", fields), options);
      expect(readExcerpt(options.dir, SESSION_A)).toBeNull();
    }
  });

  it.each([
    ["isn't JSON", "{"],
    ["is null", "null"],
    ["is a list", "[]"],
    ["is a string", '"Stop"'],
    ["names another event", input("PreToolUse", { tool_name: "Bash" })],
    ["names no event", JSON.stringify({ session_id: SESSION_A })],
    ["has no session id", JSON.stringify({ hook_event_name: "Stop" })],
    ["has a session id that isn't a UUID", input("Stop", { session_id: "../../../etc/passwd" })],
    ["has an uppercase session id", input("Stop", { session_id: SESSION_A.toUpperCase() })],
    ["has a numeric session id", input("Stop", { session_id: 7 })],
  ])("writes nothing, and doesn't throw, for an input that %s", (_, text) => {
    expect(() => recordEvent(text, options)).not.toThrow();
    expect(filesUnder(root)).toEqual([]);
  });

  it("writes nothing to a spool's directory that others may open", () => {
    mkdirSync(options.dir, { mode: 0o700 });
    chmodSync(options.dir, 0o755);
    recordEvent(input("Stop", { last_assistant_message: "Done." }), options);
    expect(filesUnder(root)).toEqual([]);
  });
});

describe("runHook", () => {
  it("records an input that comes in chunks, as text or bytes", async () => {
    const text = input("UserPromptSubmit");
    await runHook(chunks(text.slice(0, 10), new TextEncoder().encode(text.slice(10))), options);
    expect(readEvents(options.dir)).toEqual([
      { at: NOW, event: "UserPromptSubmit", session: SESSION_A },
    ]);
  });

  it("drops an input past its bound whole", async () => {
    const huge = input("PostToolUse", { tool_response: "x".repeat(MAX_INPUT_BYTES) });
    await runHook(chunks(huge), options);
    expect(filesUnder(root)).toEqual([]);
  });

  it("never throws, when its input fails or its disk does", async () => {
    async function* failing(): AsyncIterable<string> {
      yield "{";
      throw new Error("EPIPE");
    }
    await expect(runHook(failing(), options)).resolves.toBeUndefined();
    // The events file can't be opened: a directory stands in its place.
    mkdirSync(join(options.dir, EVENTS_FILE), { recursive: true });
    chmodSync(options.dir, 0o700);
    await expect(runHook(chunks(input("Stop")), options)).resolves.toBeUndefined();
  });
});

describe("readInput", () => {
  it("reads up to its bound, and no more", async () => {
    expect(await readInput(chunks("ab", "cd"), 4)).toBe("abcd");
    expect(await readInput(chunks("ab", "cde"), 4)).toBeNull();
    expect(await readInput(chunks(), 4)).toBe("");
  });
});

/** The hook's environment: the owner's home, here a test's. Bun's own cache stays out of it. */
const hookEnv = (home: string) => ({
  HOME: home,
  PATH: process.env.PATH,
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
});

describe("hooks/session-event.ts, as Claude Code runs it with Bun", () => {
  const run = (home: string, stdin: string) =>
    spawnSync("bun", [HOOK], {
      input: stdin,
      env: hookEnv(home),
      encoding: "utf8",
      timeout: 15_000,
    });

  it("exits 0 and prints nothing, writing only its spool", () => {
    const home = join(root, "home");
    mkdirSync(home);
    const result = run(home, input("Stop", { last_assistant_message: "Done, PR opened." }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const spool = relative(home, spoolDirOf(home));
    expect(filesUnder(home)).toEqual([
      join(spool, EVENTS_FILE),
      join(spool, `excerpt-${SESSION_A}.json`),
    ]);
    expect(readExcerpt(spoolDirOf(home), SESSION_A)?.text).toBe("Done, PR opened.");
  });

  it.each([
    ["no input", ""],
    ["text", "hello"],
    ["a list", "[1,2,3]"],
    ["another event", input("PreToolUse")],
    ["a path for a session id", input("Stop", { session_id: "../../x" })],
  ])("exits 0 and writes nothing on %s", (_, stdin) => {
    const home = join(root, "home");
    mkdirSync(home);
    const result = run(home, stdin);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(filesUnder(home)).toEqual([]);
  });

  it("stops itself, with 0, when its input never ends", async () => {
    const home = join(root, "home");
    mkdirSync(home);
    const started = Date.now();
    const child = spawn("bun", [HOOK], { env: hookEnv(home) });
    child.stdin.write('{"hook_event_name":"Stop"');
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOOK_DEADLINE_MS);
    expect(Date.now() - started).toBeLessThan(HOOK_DEADLINE_MS + 5_000);
    expect(filesUnder(home)).toEqual([]);
  }, 15_000);
});
