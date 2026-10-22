import { join } from "node:path";
import { readSmall } from "./files.ts";
import { HOOK_EXCERPT_CHARS, HOOK_REDACT_CHARS, MAX_INPUT_BYTES, readInput } from "./hook.ts";
import { INVISIBLE, type RunnerVerdict, SESSION_ID, TOOL_NAME } from "./protocol.ts";
import { cut, redact } from "./redact.ts";
import { MAX_SESSION_FILE_BYTES, parseSessionFile, type SessionFile } from "./session-files.ts";
import {
  agentOf,
  deleteRequest,
  prepareSpoolDir,
  readVerdict,
  takeVerdict,
  writeRequest,
} from "./spool.ts";

// The permission hook (ADR-0069 §1), which hooks/permission-request.ts runs for each permission
// prompt. It waits only in the Claude app's sessions, beside the prompt the app shows, and the
// first answer wins: an answer there, the runner's verdict here, or neither by its deadline. On any doubt it returns no decision, which leaves the prompt as it was, and it
// never stands in a session's way: Claude Code doesn't wait for it while its prompt shows.

/** The hook's command in `settings.json` (docs/runner.md), as the session-event hook's. */
export const PERMISSION_HOOK_COMMAND =
  'cd "$HOME/Repos/kelpie/tools/runner" && exec "$HOME/.bun/bin/bun" --no-env-file --config=hooks/bunfig.toml hooks/permission-request.ts';
/** The hook's `timeout` in `settings.json`: Claude Code's default for a command hook. */
export const PERMISSION_HOOK_TIMEOUT_S = 600;
/** How long the hook waits for a verdict: its own deadline, half a minute inside its timeout. */
export const PERMISSION_WAIT_MS = 570_000;
/** How often it looks for a verdict, and at its session's file. */
export const VERDICT_POLL_MS = 500;
/**
 * The sessions the hook waits in, by their file's `entrypoint`: the Claude app's, whose host shows
 * its prompt while the hook waits (ADR-0069 §1). A terminal's has no host beside the hook, and the
 * runner's own sessions run through the Agent SDK, with an entrypoint of their own; a `-p` run's,
 * `sdk-cli`, has no one to show a prompt to, and Claude Code waits for its hooks there.
 */
export const APP_ENTRYPOINT = "claude-desktop";
/** What the session reads when the owner denied through Kelpie. */
export const DENIED_MESSAGE = "The owner denied this through Kelpie.";
/** The tool whose permission request is a question: only its prompt answers it. */
const QUESTION_TOOL = "AskUserQuestion";
/** Reads in a row that find no session file before the hook takes it as gone. */
const MISSES_FOR_GONE = 2;
const INVISIBLES = new RegExp(INVISIBLE.source, "gu");

export interface PermissionHookOptions {
  /** The spool's directory. */
  dir: string;
  /** Claude Code's folder, which holds `sessions/`. */
  claudeDir: string;
  /** The owner's user, whose private directory the spool must be. */
  uid: number;
  /** The session's Claude Code process: the hook's parent, since its command `exec`s Bun. */
  parentPid: number;
  /** The hook's own process. */
  pid: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  randomId: () => string;
  /** Aborted when the hook is stopped, as when its session ends. */
  signal?: AbortSignal;
  waitMs?: number;
  pollMs?: number;
}

/**
 * Everything the hook does with its input: what it prints, a decision or `""` for none. It never
 * throws, whatever the input, the disk or the session's file.
 */
export async function runPermissionHook(
  input: AsyncIterable<Uint8Array | string>,
  options: PermissionHookOptions,
): Promise<string> {
  try {
    const text = await readInput(input, MAX_INPUT_BYTES);
    return text === null ? "" : await waitForVerdict(text, options);
  } catch {
    return "";
  }
}

async function waitForVerdict(input: string, options: PermissionHookOptions): Promise<string> {
  const { dir, now, sleep, signal } = options;
  const payload = parsePayload(input);
  if (payload === null) return "";
  const { session, tool } = payload;
  const own = () => sessionFileOf(options.claudeDir, options.parentPid, session);
  const file = own();
  if (file === null || file.entrypoint !== APP_ENTRYPOINT) return "";
  if (!prepareSpoolDir(dir, options.uid)) return "";
  const start = now();
  const id = options.randomId();
  writeRequest(dir, {
    id,
    session,
    ...(payload.agent === undefined ? {} : { agent: payload.agent }),
    at: start,
    deadline: start + (options.waitMs ?? PERMISSION_WAIT_MS),
    pid: options.pid,
    tool,
    input: requestTextOf(payload.input),
  });
  const watch = sessionWatch(start);
  watch.saw(file);
  try {
    for (;;) {
      const verdict = readVerdict(dir, id);
      // Taking it is what applies it: a verdict the runner took back first isn't.
      if (verdict && takeVerdict(dir, id)) return decisionOf(verdict.behavior);
      if (signal?.aborted || now() - start >= (options.waitMs ?? PERMISSION_WAIT_MS)) return "";
      if (watch.movedOn(own())) return "";
      await sleep(options.pollMs ?? VERDICT_POLL_MS);
    }
  } finally {
    deleteRequest(dir, id);
  }
}

/** The fields the hook reads from its input; null for any input it doesn't wait on. */
function parsePayload(
  input: string,
): { session: string; tool: string; input: unknown; agent?: string | null } | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { hook_event_name, session_id, tool_name, tool_input, agent_id } = value as Record<
    string,
    unknown
  >;
  if (hook_event_name !== "PermissionRequest") return null;
  if (typeof session_id !== "string" || !SESSION_ID.test(session_id)) return null;
  if (typeof tool_name !== "string" || !TOOL_NAME.test(tool_name) || tool_name === QUESTION_TOOL) {
    return null;
  }
  // A subagent's prompt carries its `agent_id`, as its events do (#482); the main thread's none.
  const agent = agent_id === undefined || agent_id === null ? undefined : agentOf(agent_id);
  return {
    session: session_id,
    tool: tool_name,
    input: tool_input,
    ...(agent === undefined ? {} : { agent }),
  };
}

/**
 * Whether the session moved on from the prompt: its file is gone, or no longer waits after it did,
 * as when the owner answered in the app; or it turned idle after the hook started, should the file
 * never have said it waits.
 */
function sessionWatch(start: number) {
  let waited = false;
  let misses = 0;
  const saw = (file: SessionFile) => {
    misses = 0;
    if (file.status === "waiting") waited = true;
  };
  return {
    saw,
    movedOn(file: SessionFile | null): boolean {
      if (file === null) {
        misses += 1;
        return misses >= MISSES_FOR_GONE;
      }
      saw(file);
      if (file.status === "waiting") return false;
      return waited || (file.status === "idle" && (file.statusUpdatedAt ?? -1) >= start);
    },
  };
}

/** The session's file, `<claudeDir>/sessions/<pid>.json`, when it names this session. */
function sessionFileOf(claudeDir: string, pid: number, session: string): SessionFile | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const text = readSmall(join(claudeDir, "sessions", `${pid}.json`), MAX_SESSION_FILE_BYTES);
  const file = text === null ? null : parseSessionFile(text, () => true);
  return file?.id === session ? file : null;
}

/**
 * A tool's input as the request shows it: each field on its own line, a text as it is and anything
 * else as JSON. A text of several lines starts below its name, so a file's lines stay lines the
 * redaction reads, its first one too. What shows nothing goes first: it
 * could split a key. The first HOOK_REDACT_CHARS are redacted, and HOOK_EXCERPT_CHARS kept: the
 * runner redacts again, its own secret by value too, before it cuts what leaves.
 */
export function requestTextOf(input: unknown): string {
  const text =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? Object.entries(input)
          .map(([name, value]) => fieldOf(name, value))
          .join("\n")
      : (JSON.stringify(input) ?? "");
  const visible = cut(text, HOOK_REDACT_CHARS).replace(INVISIBLES, "");
  return cut(redact(visible), HOOK_EXCERPT_CHARS);
}

function fieldOf(name: string, value: unknown): string {
  if (typeof value !== "string") return `${name}: ${JSON.stringify(value)}`;
  return /[\r\n]/.test(value) ? `${name}:\n${value}` : `${name}: ${value}`;
}

/** The hook's output for a verdict, as Claude Code reads a `PermissionRequest` hook's. */
export function decisionOf(behavior: RunnerVerdict): string {
  const decision = behavior === "allow" ? { behavior } : { behavior, message: DENIED_MESSAGE };
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
  });
}
