import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRunnerVpsRequests } from "../../../packages/channels/src/runner.ts";
import { requestTextOf } from "../src/permission-hook.ts";
import type { ProcessInfo } from "../src/processes.ts";
import { MAX_INPUT_CHARS, MAX_VPS_SESSIONS } from "../src/protocol.ts";
import { REDACTED } from "../src/redact.ts";
import { ownUid } from "../src/secrets.ts";
import {
  listActions,
  prepareSpoolDir,
  readVerdict,
  type SpoolRequest,
  takeVerdict,
  writeRequest,
  writeSocket,
  writeVerdict,
} from "../src/spool.ts";
import { VERDICT_APPLY_MS, VpsSessions, type VpsSessionsOptions } from "../src/vps-sessions.ts";
import {
  type FakeVps,
  fakeVps,
  HOUR,
  MINUTE,
  makeCheckout,
  NOW,
  RUNNER_SECRET,
  SESSION_A,
  SESSION_B,
  sessionFields,
  spoolEvent,
  writeEvents,
  writeSessionFile,
} from "./fake-vps.ts";
import { SECRET_SAMPLES } from "./secret-samples.ts";

// Acting on the VPS's sessions (ADR-0069): the permission prompts the hook holds open and the
// verdicts on them, a message to a session's inbox, and a session's end.

const REQUEST = "eeeeeeee-0000-4000-8000-00000000000e";
const OTHER_REQUEST = "ffffffff-0000-4000-8000-00000000000f";
const APP_BINARY = "/home/owner/.claude/remote/ccd-cli/2.1.299-686c67ec1014";
/** The hook's process, which the fake `alive` says runs. */
const HOOK_PID = 501;

let vps: FakeVps;
let clock: number;
let servers: Server[];
beforeEach(() => {
  vps = fakeVps();
  clock = NOW;
  servers = [];
  makeCheckout(join(vps.repos, "kelpie"));
  prepareSpoolDir(vps.spoolDir, ownUid());
});
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  vps.cleanup();
});

function service(overrides: Partial<VpsSessionsOptions> = {}) {
  const killed: [number, string][] = [];
  const sessions = new VpsSessions({
    claudeDir: vps.claudeDir,
    spoolDir: vps.spoolDir,
    workDir: vps.workDir,
    holds: () => false,
    secrets: [RUNNER_SECRET],
    warn: () => {},
    now: () => clock,
    alive: (pid) => pid < 9_000,
    uid: ownUid(),
    sleep: async (ms) => {
      clock += ms;
    },
    claudeCodeDirs: ["/home/owner/.claude/remote/ccd-cli"],
    processInfo: () => ({ uid: ownUid(), start: "42070362", exe: APP_BINARY }),
    kill: (pid, signal) => killed.push([pid, signal]),
    ...overrides,
  });
  return { sessions, killed };
}

/** Session A, an app session waiting on a permission prompt the hook spooled `ago` ms ago. */
function waitingSession({ ago = 20_000, fields = {} as Record<string, unknown> } = {}) {
  writeSessionFile(
    vps,
    sessionFields({
      pid: 101,
      cwd: join(vps.repos, "kelpie"),
      status: "waiting",
      waitingFor: "permission prompt",
      statusUpdatedAt: NOW - ago - 40,
      ...fields,
    }),
  );
  writeEvents(vps, [spoolEvent("PermissionRequest", NOW - ago)]);
}

function spoolRequest(overrides: Partial<SpoolRequest> = {}): SpoolRequest {
  return {
    id: REQUEST,
    session: SESSION_A,
    at: NOW - 20_000,
    deadline: NOW + 550_000,
    pid: HOOK_PID,
    tool: "Bash",
    input: "command: rm -rf build\ndescription: Clean the build",
    whole: true,
    ...overrides,
  };
}

/** The answer as it goes out, and as channel-egress checks it. */
function requested(sessions: VpsSessions) {
  const answer = sessions.requests();
  expect(parseRunnerVpsRequests(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  return answer;
}

describe("VpsSessions.requests", () => {
  it("lists an open request with its session's title and repository, its input on one line", () => {
    waitingSession();
    writeRequest(vps.spoolDir, spoolRequest());
    expect(requested(service().sessions)).toEqual({
      ok: true,
      now: NOW,
      requests: [
        {
          id: REQUEST,
          sessionId: SESSION_A,
          tool: "Bash",
          input: "command: rm -rf build description: Clean the build",
          truncated: false,
          openedAt: NOW - 20_000,
          title: "Review the runner's sessions",
          repository: "kelpie",
        },
      ],
      truncated: false,
    });
  });

  it("redacts the input again, the runner's own secret by value too, then cuts it", () => {
    waitingSession();
    const input = `command: deploy --key ${RUNNER_SECRET} ${"x ".repeat(400)}`;
    writeRequest(vps.spoolDir, spoolRequest({ input }));
    const [listed] = requested(service().sessions).requests;
    expect(listed?.input).toContain(REDACTED);
    expect(listed?.input).not.toContain(RUNNER_SECRET);
    expect(listed?.input.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(listed?.truncated).toBe(true);
  });

  it("says an input is cut short when the hook kept only part of it, and squeezes its blanks", () => {
    waitingSession();
    writeRequest(
      vps.spoolDir,
      spoolRequest({ input: "command: ls\n\n\t  ;  rm -rf /", whole: false }),
    );
    const [listed] = requested(service().sessions).requests;
    expect(listed).toMatchObject({ input: "command: ls ; rm -rf /", truncated: true });
  });

  it.each(SECRET_SAMPLES)(
    "leaves out %s, redacted in the hook and in the runner",
    (_, toolInput, secret) => {
      waitingSession();
      writeRequest(vps.spoolDir, spoolRequest(requestTextOf(toolInput)));
      const [listed] = requested(service().sessions).requests;
      expect(listed?.input).toContain(REDACTED);
      expect(listed?.input).not.toContain(secret);
    },
  );

  it.each(SECRET_SAMPLES)(
    "leaves out %s in the runner alone, should the hook miss it",
    (_, toolInput, secret) => {
      waitingSession();
      const raw = Object.entries(toolInput)
        .map(([name, value]) =>
          typeof value === "string" && /\n/.test(value)
            ? `${name}:\n${value}`
            : `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
        )
        .join("\n");
      writeRequest(vps.spoolDir, spoolRequest({ input: raw }));
      const [listed] = requested(service().sessions).requests;
      expect(listed?.input).not.toContain(secret);
    },
  );

  it("lists a subagent's request on its own thread's wait", () => {
    waitingSession();
    writeEvents(vps, [spoolEvent("PermissionRequest", NOW - 10_000, { agent: "a1b2c3" })]);
    writeRequest(vps.spoolDir, spoolRequest({ at: NOW - 10_000, agent: "a1b2c3" }));
    expect(requested(service().sessions).requests.map(({ id }) => id)).toEqual([REQUEST]);
  });

  it.each([
    ["its hook is gone", () => writeRequest(vps.spoolDir, spoolRequest({ pid: 9_500 }))],
    ["its deadline passed", () => writeRequest(vps.spoolDir, spoolRequest({ deadline: NOW }))],
    [
      "a verdict was given",
      () => {
        writeRequest(vps.spoolDir, spoolRequest());
        writeVerdict(vps.spoolDir, { id: REQUEST, behavior: "allow", at: NOW });
      },
    ],
    [
      "the owner answered in the app: the tool ran",
      () => {
        writeRequest(vps.spoolDir, spoolRequest());
        writeEvents(vps, [
          spoolEvent("PermissionRequest", NOW - 20_000),
          spoolEvent("PostToolUse", NOW - 5_000),
        ]);
        writeSessionFile(
          vps,
          sessionFields({ pid: 101, status: "busy", statusUpdatedAt: NOW - 5_000 }),
        );
      },
    ],
    [
      "it is a subagent's whose thread waits on nothing",
      () => writeRequest(vps.spoolDir, spoolRequest({ agent: "a1b2c3" })),
    ],
    [
      "its thread's wait opened at another prompt",
      () => writeRequest(vps.spoolDir, spoolRequest({ at: NOW - 20_000 - 2 * MINUTE })),
    ],
    [
      "its session ended",
      () => {
        writeRequest(vps.spoolDir, spoolRequest());
        // Its process is gone: the file left behind names a pid nothing runs.
        writeSessionFile(vps, sessionFields({ pid: 9_600, status: "waiting" }), "101");
      },
    ],
    [
      "its session has no file",
      () => writeRequest(vps.spoolDir, spoolRequest({ session: SESSION_B })),
    ],
  ])("leaves out a request when %s", (_, arrange) => {
    waitingSession();
    arrange();
    expect(requested(service().sessions).requests).toEqual([]);
  });

  it("leaves out an earlier request of the same thread, whose prompt was answered", () => {
    waitingSession({ ago: 5_000 });
    writeEvents(vps, [
      spoolEvent("PermissionRequest", NOW - 20_000),
      spoolEvent("PostToolUse", NOW - 15_000),
      spoolEvent("PermissionRequest", NOW - 5_000),
    ]);
    writeRequest(vps.spoolDir, spoolRequest({ at: NOW - 20_000 }));
    writeRequest(vps.spoolDir, spoolRequest({ id: OTHER_REQUEST, at: NOW - 5_000 }));
    expect(requested(service().sessions).requests.map(({ id }) => id)).toEqual([OTHER_REQUEST]);
  });

  it("leaves out the claude-code route's own sessions", () => {
    waitingSession();
    writeRequest(vps.spoolDir, spoolRequest());
    expect(requested(service({ holds: (id) => id === SESSION_A }).sessions).requests).toEqual([]);
  });

  it("lists none from a spool others may open", () => {
    waitingSession();
    writeRequest(vps.spoolDir, spoolRequest());
    chmodSync(vps.spoolDir, 0o755);
    expect(requested(service().sessions).requests).toEqual([]);
  });

  it(`lists ${MAX_VPS_SESSIONS} requests at most, oldest first, and says so`, () => {
    waitingSession();
    // One per subagent: a thread asks one prompt at a time.
    const events = [];
    for (let index = 0; index <= MAX_VPS_SESSIONS; index += 1) {
      const id = `eeeeeeee-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const at = NOW - 20_000 + index;
      events.push(spoolEvent("PermissionRequest", at, { agent: `agent${index}` }));
      writeRequest(vps.spoolDir, spoolRequest({ id, at, agent: `agent${index}` }));
    }
    writeEvents(vps, events);
    const answer = requested(service().sessions);
    expect(answer.requests).toHaveLength(MAX_VPS_SESSIONS);
    expect(answer.requests[0]?.openedAt).toBe(NOW - 20_000);
    expect(answer.truncated).toBe(true);
  });
});

describe("VpsSessions.verdict", () => {
  beforeEach(() => {
    waitingSession();
    writeRequest(vps.spoolDir, spoolRequest());
  });

  it("gives the hook the verdict, and says it applied once the hook took it", async () => {
    const { sessions } = service({
      sleep: async (ms) => {
        clock += ms;
        // The hook's next look.
        if (readVerdict(vps.spoolDir, REQUEST)?.behavior === "allow")
          takeVerdict(vps.spoolDir, REQUEST);
      },
    });
    expect(await sessions.verdict(REQUEST, "allow")).toEqual({ ok: true, applied: true });
  });

  it("takes back a verdict no hook took in time, so it never applies unseen", async () => {
    const { sessions } = service();
    expect(await sessions.verdict(REQUEST, "deny")).toEqual({ ok: true, applied: false });
    expect(clock).toBeGreaterThanOrEqual(NOW + VERDICT_APPLY_MS);
    expect(listActions(vps.spoolDir).verdicts).toEqual([]);
  });

  it("counts once: a second verdict while the first waits for its hook is closed", async () => {
    writeVerdict(vps.spoolDir, { id: REQUEST, behavior: "allow", at: NOW });
    expect(await service().sessions.verdict(REQUEST, "deny")).toEqual({
      ok: false,
      reason: "closed",
    });
    expect(readVerdict(vps.spoolDir, REQUEST)?.behavior).toBe("allow");
  });

  it.each([
    ["a request that isn't there", OTHER_REQUEST],
    ["an id that isn't a UUID", "../request"],
  ])("closes on %s", async (_, id) => {
    expect(await service().sessions.verdict(id, "allow")).toEqual({ ok: false, reason: "closed" });
  });

  it("closes on a request the owner answered in the app first", async () => {
    writeSessionFile(
      vps,
      sessionFields({ pid: 101, status: "idle", statusUpdatedAt: NOW - 1_000 }),
    );
    expect(await service().sessions.verdict(REQUEST, "allow")).toEqual({
      ok: false,
      reason: "closed",
    });
    expect(listActions(vps.spoolDir).verdicts).toEqual([]);
  });

  it("closes on a spool others may open", async () => {
    chmodSync(vps.spoolDir, 0o755);
    expect(await service().sessions.verdict(REQUEST, "allow")).toEqual({
      ok: false,
      reason: "closed",
    });
  });
});

describe("VpsSessions.message", () => {
  /** An inbox that keeps the lines it got, in a directory only the runner's user may open. */
  async function inbox(): Promise<{ path: string; lines: string[] }> {
    const dir = join(vps.root, "socks");
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const path = join(dir, "101.sock");
    const lines: string[] = [];
    const server = createServer((connection) => {
      let text = "";
      connection.on("data", (chunk) => {
        text += chunk;
      });
      connection.on("end", () => {
        lines.push(...text.split("\n").filter(Boolean));
        connection.end();
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(path, done));
    return { path, lines };
  }

  function liveSession(fields: Record<string, unknown> = {}) {
    writeSessionFile(vps, sessionFields({ pid: 101, status: "idle", ...fields }));
  }

  it("posts the text to the inbox the SessionStart hook recorded for the session's process", async () => {
    liveSession();
    const { path, lines } = await inbox();
    writeSocket(vps.spoolDir, SESSION_A, { at: NOW - 5 * HOUR + 1_000, path });
    expect(await service().sessions.message(SESSION_A, "Rebase on main, please.")).toEqual({
      ok: true,
    });
    await new Promise((done) => setTimeout(done, 20));
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { type: "user", message: { role: "user", content: "Rebase on main, please." } },
    ]);
  });

  it.each([
    ["no session has the id", () => {}, SESSION_B, "not_found"],
    ["its process is gone", () => liveSession({ pid: 9_700 }), SESSION_A, "ended"],
    ["no inbox was recorded", () => liveSession(), SESSION_A, "no_inbox"],
    [
      "its inbox was recorded before its process started, by an older one",
      () => {
        liveSession();
        writeSocket(vps.spoolDir, SESSION_A, { at: NOW - 6 * HOUR, path: "/tmp/x.sock" });
      },
      SESSION_A,
      "no_inbox",
    ],
    [
      "its process says no start time",
      () => {
        liveSession({ startedAt: undefined });
        writeSocket(vps.spoolDir, SESSION_A, { at: NOW, path: "/tmp/x.sock" });
      },
      SESSION_A,
      "no_inbox",
    ],
    [
      "its inbox isn't a socket",
      () => {
        liveSession();
        writeFileSync(join(vps.root, "not-a.sock"), "");
        writeSocket(vps.spoolDir, SESSION_A, { at: NOW, path: join(vps.root, "not-a.sock") });
      },
      SESSION_A,
      "no_inbox",
    ],
  ])("refuses when %s", async (_, arrange, id, reason) => {
    arrange();
    expect(await service().sessions.message(id, "hi")).toEqual({ ok: false, reason });
  });

  it("refuses when no one listens on the inbox any more", async () => {
    liveSession();
    const { path } = await inbox();
    writeSocket(vps.spoolDir, SESSION_A, { at: NOW, path });
    const { sessions } = service({ post: async () => false });
    expect(await sessions.message(SESSION_A, "hi")).toEqual({ ok: false, reason: "no_inbox" });
  });

  it("posts nothing when the session's pid isn't its Claude Code process any more", async () => {
    liveSession();
    const { path } = await inbox();
    writeSocket(vps.spoolDir, SESSION_A, { at: NOW, path });
    const posted: string[] = [];
    const { sessions } = service({
      processInfo: () => ({ uid: ownUid(), start: "1", exe: APP_BINARY }),
      post: async (_path, text) => {
        posted.push(text);
        return true;
      },
    });
    expect(await sessions.message(SESSION_A, "hi")).toEqual({
      ok: false,
      reason: "not_claude_code",
    });
    expect(posted).toEqual([]);
  });

  it("refuses the claude-code route's own sessions", async () => {
    liveSession();
    const { sessions } = service({ holds: () => true });
    expect(await sessions.message(SESSION_A, "hi")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("VpsSessions.end", () => {
  beforeEach(() => {
    writeSessionFile(vps, sessionFields({ pid: 101, status: "busy" }));
  });

  it("sends SIGTERM to the session's process once it checked it", () => {
    const { sessions, killed } = service();
    expect(sessions.end(SESSION_A)).toEqual({ ok: true });
    expect(killed).toEqual([[101, "SIGTERM"]]);
  });

  it.each([
    [
      "another binary's",
      { uid: ownUid(), start: "42070362", exe: "/usr/bin/python3" },
      "not_claude_code",
    ],
    [
      "another user's",
      { uid: ownUid() + 1, start: "42070362", exe: APP_BINARY },
      "not_claude_code",
    ],
    [
      "one that took the pid since",
      { uid: ownUid(), start: "1", exe: APP_BINARY },
      "not_claude_code",
    ],
    ["gone", null, "ended"],
    ["on a server that can't say", "unsupported", "unsupported"],
  ])("ends nothing when the process is %s", (_, info, reason) => {
    const { sessions, killed } = service({
      processInfo: () => info as ProcessInfo | null | "unsupported",
    });
    expect(sessions.end(SESSION_A)).toEqual({ ok: false, reason });
    expect(killed).toEqual([]);
  });

  it("ends nothing for an id no session has, an ended one, or the route's own", () => {
    const { sessions, killed } = service();
    expect(sessions.end(SESSION_B)).toEqual({ ok: false, reason: "not_found" });
    writeSessionFile(vps, sessionFields({ pid: 9_800, sessionId: SESSION_B }));
    expect(sessions.end(SESSION_B)).toEqual({ ok: false, reason: "ended" });
    expect(service({ holds: () => true }).sessions.end(SESSION_A)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(killed).toEqual([]);
  });

  it("says ended when the process went just before the signal", () => {
    const { sessions } = service({
      kill: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    });
    expect(sessions.end(SESSION_A)).toEqual({ ok: false, reason: "ended" });
  });
});

describe("the spool's sweep of actions", () => {
  it("removes a request whose hook is gone, a verdict whose request is, and an ended session's inbox", () => {
    writeSessionFile(vps, sessionFields({ pid: 9_900, status: "idle" }));
    writeRequest(vps.spoolDir, spoolRequest({ pid: 9_500 }));
    writeRequest(vps.spoolDir, spoolRequest({ id: OTHER_REQUEST, deadline: NOW - 2 * MINUTE }));
    writeVerdict(vps.spoolDir, {
      id: "abababab-0000-4000-8000-0000000000ab",
      behavior: "allow",
      at: NOW - 2 * MINUTE,
    });
    writeSocket(vps.spoolDir, SESSION_A, { at: NOW, path: "/tmp/x.sock" });
    writeSocket(vps.spoolDir, SESSION_B, { at: NOW, path: "/tmp/y.sock" });
    service().sessions.list();
    expect(listActions(vps.spoolDir)).toEqual({ requests: [], verdicts: [], sockets: [] });
  });

  it("keeps a fresh verdict, a live hook's request and a running session's inbox", () => {
    waitingSession();
    writeRequest(vps.spoolDir, spoolRequest());
    writeVerdict(vps.spoolDir, { id: OTHER_REQUEST, behavior: "deny", at: NOW - 1_000 });
    writeSocket(vps.spoolDir, SESSION_A, { at: NOW, path: "/tmp/x.sock" });
    service().sessions.list();
    expect(listActions(vps.spoolDir)).toEqual({
      requests: [REQUEST],
      verdicts: [OTHER_REQUEST],
      sockets: [SESSION_A],
    });
    expect(existsSync(join(vps.spoolDir, `request-${REQUEST}.json`))).toBe(true);
  });
});
