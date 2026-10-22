import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  RunnerActOutcome,
  RunnerSessionsOutcome,
  RunnerVerdict,
  RunnerVerdictOutcome,
  RunnerVpsSession,
} from "@kelpie/channels";
import type { Actor } from "@kelpie/config";
import { WEBCHAT_ADMISSION_HEADER } from "@kelpie/conversation/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../src/conversation-agent.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import {
  type OpenSessionRequest,
  REQUEST_ANSWER_MS,
  replaceRunnerVerdictsForTesting,
} from "../src/session-requests.ts";
import type { Tool, ToolContext, ToolProvider } from "../src/tools.ts";
import { vpsSessionsTools } from "../src/vps-sessions.ts";
import { type FakeWorld, fakeWorld } from "./fakes.ts";

// Master acting on the VPS's Claude Code sessions (ADR-0069, #497): Approve and Deny on a
// permission prompt's notice, which only the owner's press or typed code gives, never the model;
// a message to a session; and a session's end, after the owner's yes.

const MASTER = "kelpie";
const owner: Actor = { userId: "u-owner", role: "owner", via: `agent:${MASTER}` };
const member: Actor = { userId: "u-guest", role: "member", via: `agent:${MASTER}` };
const SESSION = "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f";
const REQUEST = "eeeeeeee-0000-4000-8000-00000000000e";
const NOW = Date.UTC(2026, 9, 22, 18);

const live: RunnerVpsSession = {
  id: SESSION,
  state: "working",
  since: NOW - 60_000,
  archivable: false,
  status: "busy",
  statusUpdatedAt: NOW - 60_000,
  startedAt: NOW - 3_600_000,
  alive: true,
  startedBy: "app",
  entrypoint: "claude-desktop",
  title: 'Fix "login"',
  repository: "kelpie",
  branch: "main",
  prUrl: null,
  excerpt: null,
};

function fakeSessions({
  listed = { ok: true, now: NOW, sessions: [live], truncated: false } as RunnerSessionsOutcome,
  acted = { ok: true } as RunnerActOutcome,
} = {}) {
  const calls: { message: [string, string][]; end: string[]; list: number } = {
    message: [],
    end: [],
    list: 0,
  };
  return {
    calls,
    sessions: {
      async list() {
        calls.list += 1;
        return listed;
      },
      async message(id: string, text: string) {
        calls.message.push([id, text]);
        return acted;
      },
      async end(id: string) {
        calls.end.push(id);
        return acted;
      },
    },
  };
}

function contextOf(
  actor: Actor = owner,
  trigger: ToolContext["trigger"] = "person",
  confirmed = false,
): ToolContext & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    locale: "en",
    actor,
    agentId: MASTER,
    scopes: "all",
    trigger,
    qualifier: "clef",
    turn: "1",
    source: "telegram:chat-1, 2026-10-22",
    signal: new AbortController().signal,
    async confirm(request) {
      asked.push(request);
      return confirmed;
    },
    sendLink() {},
    announce() {},
  };
}

async function toolNamed(provider: ToolProvider, name: string): Promise<Tool> {
  const tool = (await provider.tools(MASTER)).find((one) => one.spec.name === name);
  if (!tool) throw new Error(`no ${name}`);
  return tool;
}

const roleOf = async (id: string) =>
  id === MASTER ? ("master" as const) : ("specialist" as const);

afterEach(() => {
  replacePortsForTesting(undefined);
  replaceRunnerVerdictsForTesting(undefined);
  vi.restoreAllMocks();
});

describe("message_session (ADR-0069 §2)", () => {
  it("posts the owner's message to the session, as another session's, and changes nothing else", async () => {
    const { sessions, calls } = fakeSessions();
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "message_session");
    // No effect of its own, so a turn that read outside content holds it (ADR-0064).
    expect(tool.effect).toBeUndefined();
    expect(tool.spec.inputSchema.required).toEqual(["session_id", "text"]);
    const done = await tool.run({ session_id: SESSION, text: "Rebase on main." }, contextOf());
    expect(done.isError).toBeUndefined();
    expect(done.output).toContain("another Claude session's message");
    expect(calls.message).toEqual([[SESSION, "Rebase on main."]]);
  });

  it.each([
    ["a member's turn", contextOf(member), "Only the owner can act"],
    ["a turn no person typed", contextOf(owner, "note"), "only in a turn the owner started"],
  ])("refuses %s", async (_, context, words) => {
    const { sessions, calls } = fakeSessions();
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "message_session");
    const refused = await tool.run({ session_id: SESSION, text: "hi" }, context);
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain(words);
    expect(calls.message).toEqual([]);
  });

  it("refuses once the agent isn't Master any more", async () => {
    const { sessions } = fakeSessions();
    let master = true;
    const provider = vpsSessionsTools(sessions, {
      roleOf: async () => (master ? "master" : "specialist"),
    });
    const tool = await toolNamed(provider, "message_session");
    master = false;
    expect((await tool.run({ session_id: SESSION, text: "hi" }, contextOf())).output).toContain(
      "isn't Master any more",
    );
  });

  it.each([
    ["no session id", { text: "hi" }],
    ["a session id that isn't one", { session_id: "abc", text: "hi" }],
    ["no text", { session_id: SESSION }],
    ["only spaces", { session_id: SESSION, text: "   " }],
    ["text too long", { session_id: SESSION, text: "m".repeat(4_001) }],
  ])("refuses %s before calling the runner", async (_, input) => {
    const { sessions, calls } = fakeSessions();
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "message_session");
    expect((await tool.run(input, contextOf())).isError).toBe(true);
    expect(calls.message).toEqual([]);
  });

  it.each([
    ["not_found", "No session on the VPS has that id"],
    ["ended", "has ended already"],
    ["no_inbox", "no inbox Kelpie can post to"],
    ["failed", "it failed on the VPS"],
    ["outdated", "too old to act on sessions"],
    ["not_connected", "call connect_runner"],
    ["invalid_input", "Give a session id"],
    ["store_unavailable", "a Kelpie service didn't answer"],
  ] as const)("says why the runner didn't post it: %s", async (reason, words) => {
    const { sessions } = fakeSessions({ acted: { ok: false, reason } });
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "message_session");
    const said = await tool.run({ session_id: SESSION, text: "hi" }, contextOf());
    expect(said.isError).toBe(true);
    expect(said.output).toContain(words);
  });

  it("says so when channel-egress can't be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sessions } = fakeSessions();
    sessions.message = () => Promise.reject(new Error("gone"));
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "message_session");
    expect((await tool.run({ session_id: SESSION, text: "hi" }, contextOf())).output).toContain(
      "a Kelpie service didn't answer",
    );
  });
});

describe("end_session (ADR-0069 §3)", () => {
  it("asks the owner first, naming the session as quoted data, and ends nothing before the yes", async () => {
    const { sessions, calls } = fakeSessions();
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "end_session");
    expect(tool.effect).toBe("asks");
    const context = contextOf();
    const waiting = await tool.run({ session_id: SESSION }, context);
    expect(waiting.output).toContain("waits for their confirmation");
    expect(context.asked).toEqual([
      {
        command: "endSession",
        input: { sessionId: SESSION },
        summary:
          'End the Claude Code session "Fix \\"login\\"" in "kelpie" on your VPS? Its process gets SIGTERM, and Claude Code ends it cleanly. Archiving it stays in the Claude app.',
      },
    ]);
    expect(calls.end).toEqual([]);
  });

  it("ends the session once the owner confirmed it", async () => {
    const { sessions, calls } = fakeSessions();
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "end_session");
    const ended = await tool.run({ session_id: SESSION }, contextOf(owner, "person", true));
    expect(ended.output).toContain("SIGTERM");
    expect(calls.end).toEqual([SESSION]);
  });

  it("asks in the owner's language", async () => {
    const { sessions } = fakeSessions();
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "end_session");
    const context = { ...contextOf(), locale: "pt-BR" as const };
    await tool.run({ session_id: SESSION }, context);
    expect(JSON.stringify(context.asked)).toContain("Encerrar a sessão do Claude Code");
  });

  it.each([
    ["no such session", { ok: true, now: NOW, sessions: [], truncated: false }, "No session"],
    [
      "one that ended",
      { ok: true, now: NOW, sessions: [{ ...live, state: "ended" }], truncated: false },
      "has ended already",
    ],
    ["an outdated runner", { ok: false, reason: "outdated" }, "too old"],
  ] as const)("asks nothing for %s", async (_, listed, words) => {
    const { sessions, calls } = fakeSessions({ listed: listed as RunnerSessionsOutcome });
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "end_session");
    const context = contextOf();
    expect((await tool.run({ session_id: SESSION }, context)).output).toContain(words);
    expect(context.asked).toEqual([]);
    expect(calls.end).toEqual([]);
  });

  it.each([
    ["not_claude_code", "isn't a Claude Code process"],
    ["unsupported", "can't check a process"],
  ] as const)("says why the runner ended nothing: %s", async (reason, words) => {
    const { sessions } = fakeSessions({ acted: { ok: false, reason } });
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "end_session");
    expect(
      (await tool.run({ session_id: SESSION }, contextOf(owner, "person", true))).output,
    ).toContain(words);
  });

  it("refuses a member, a turn no person typed, and an id that isn't one", async () => {
    const { sessions, calls } = fakeSessions();
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "end_session");
    expect((await tool.run({ session_id: SESSION }, contextOf(member))).isError).toBe(true);
    expect((await tool.run({ session_id: SESSION }, contextOf(owner, "task"))).isError).toBe(true);
    expect((await tool.run({ session_id: "x" }, contextOf())).isError).toBe(true);
    expect(calls.list).toBe(0);
  });

  it("says so when channel-egress can't be reached to look the session up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sessions } = fakeSessions();
    sessions.list = () => Promise.reject(new Error("gone"));
    const tool = await toolNamed(vpsSessionsTools(sessions, { roleOf }), "end_session");
    expect((await tool.run({ session_id: SESSION }, contextOf())).output).toContain(
      "a Kelpie service didn't answer",
    );
  });
});

describe("Approve and Deny on a permission prompt's notice (ADR-0069 §1)", () => {
  const agent = (name: string) => env.CONVERSATION_AGENT.getByName(name);
  const wait = {
    kind: "permission",
    title: "Fix login",
    repository: "kelpie",
    request: { id: REQUEST, tool: "Bash", input: "command: rm -rf build" },
  } as const;

  function use(world: FakeWorld): FakeWorld {
    replacePortsForTesting(world.ports);
    return world;
  }

  /** A RunnerSessions that answers each verdict with `outcome`, recording them. */
  function runner(outcome: RunnerVerdictOutcome | (() => Promise<RunnerVerdictOutcome>)) {
    const given: [string, RunnerVerdict][] = [];
    replaceRunnerVerdictsForTesting({
      async verdict(id, verdict) {
        given.push([id, verdict]);
        return typeof outcome === "function" ? outcome() : outcome;
      },
    });
    return given;
  }

  async function bound(name: string, channel: "telegram" | "webchat" = "telegram") {
    await agent(name).ingest({
      agentId: MASTER,
      providerMessageId: `${name}-m1`,
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: "hello there, how are you doing today?",
      destination: { channel, threadId: "u-owner" },
      sentAt: Date.UTC(2026, 9, 22, 17),
      timeZone: null,
    });
    await runInDurableObject(agent(name), async (instance: ConversationAgent) => {
      for (const schedule of instance.getSchedules()) await instance.cancelSchedule(schedule.id);
    });
  }

  const kept = (name: string) =>
    runInDurableObject(agent(name), (_instance: ConversationAgent, state) => {
      const [row] = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM state WHERE key = 'sessionRequests'")
        .toArray();
      return row ? (JSON.parse(row.value) as OpenSessionRequest[]) : [];
    });

  it("names the tool and its input on Telegram, and sends the owner to the Claude app until #495's buttons", async () => {
    const world = use(fakeWorld([]));
    const name = `${MASTER}:telegram:request-told`;
    await bound(name);
    expect(await agent(name).sessionWait(MASTER, wait)).toBe("sent");
    expect(world.sends).toEqual([
      {
        text: 'A Claude Code session on your VPS is waiting for your permission: "Fix login", repository "kelpie".\nTool: Bash, with "command: rm -rf build".\nAnswer it in the Claude app.',
        silent: false,
      },
    ]);
    // No buttons there, so nothing a press could answer.
    expect(await kept(name)).toEqual([]);
  });

  it("never takes a typed message as a verdict: it reaches the conversation as any other", async () => {
    use(fakeWorld([]));
    const given = runner({ ok: true, applied: true });
    const name = `${MASTER}:telegram:request-typed`;
    await bound(name);
    await agent(name).sessionWait(MASTER, wait);
    const answered = await agent(name).ingest({
      agentId: MASTER,
      providerMessageId: `${name}-m2`,
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      text: `approve ${REQUEST}`,
      destination: { channel: "telegram", threadId: "u-owner" },
      sentAt: Date.now(),
      timeZone: null,
    });
    expect(answered.status).toBe("accepted");
    expect(given).toEqual([]);
  });

  it("gives no request to a question's notice, which only its prompt answers", async () => {
    use(fakeWorld([]));
    const name = `${MASTER}:telegram:request-question`;
    await bound(name);
    expect(await agent(name).sessionWait(MASTER, { ...wait, kind: "question" })).toBe("bad_input");
    expect(
      await agent(name).sessionWait(MASTER, { ...wait, request: { ...wait.request, id: "x" } }),
    ).toBe("bad_input");
    expect(await kept(name)).toEqual([]);
  });

  describe("in the webchat", () => {
    async function socketOf(name: string, role = "owner") {
      const response = await agent(name).fetch("https://conversation/webchat", {
        headers: {
          Upgrade: "websocket",
          [WEBCHAT_ADMISSION_HEADER]: JSON.stringify({
            agentId: MASTER,
            userId: "u-owner",
            role,
            chatType: "direct",
            timeZone: null,
          }),
        },
      });
      const socket = response.webSocket;
      if (!socket) throw new Error("no socket");
      const frames: Record<string, unknown>[] = [];
      socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
      socket.accept();
      return { socket, frames };
    }

    it("shows Approve and Deny, which send the verdict by the request's id", async () => {
      use(fakeWorld([]));
      const given = runner({ ok: true, applied: true });
      const name = `${MASTER}:webchat:u-owner`;
      await bound(name, "webchat");
      const { socket, frames } = await socketOf(name);
      expect(await agent(name).sessionWait(MASTER, wait)).toBe("sent");
      const [request] = await kept(name);
      await vi.waitFor(() =>
        expect(frames.filter((frame) => frame.type === "bubble")).toEqual([
          {
            type: "bubble",
            text: 'A Claude Code session on your VPS is waiting for your permission: "Fix login", repository "kelpie".\nTool: Bash, with "command: rm -rf build".\nApprove or deny it here, or answer it in the Claude app.',
            sessionRequest: { id: REQUEST, until: request?.expiresAt },
          },
        ]),
      );
      socket.send(
        JSON.stringify({ type: "verdict", id: REQUEST, verdict: "allow", agent: MASTER }),
      );
      await vi.waitFor(() =>
        expect(frames.filter((frame) => frame.type === "verdict")).toEqual([
          { type: "verdict", id: REQUEST, verdict: "allow", status: "applied" },
        ]),
      );
      expect(given).toEqual([[REQUEST, "allow"]]);
      // A second press counts for nothing.
      socket.send(JSON.stringify({ type: "verdict", id: REQUEST, verdict: "deny" }));
      await vi.waitFor(() =>
        expect(frames.filter((frame) => frame.type === "verdict").at(-1)).toMatchObject({
          status: "answered",
        }),
      );
      expect(given).toHaveLength(1);
      socket.close(1000);
    });

    /** Tells the webchat's notice, and gives what each press answered. */
    async function told(name: string) {
      await bound(name, "webchat");
      const { socket, frames } = await socketOf(name);
      await agent(name).sessionWait(MASTER, wait);
      const press = async (verdict: RunnerVerdict) => {
        const before = frames.filter((frame) => frame.type === "verdict").length;
        socket.send(JSON.stringify({ type: "verdict", id: REQUEST, verdict }));
        await vi.waitFor(() =>
          expect(frames.filter((frame) => frame.type === "verdict").length).toBe(before + 1),
        );
        return frames.filter((frame) => frame.type === "verdict").at(-1)?.status;
      };
      return { socket, press };
    }

    it("leaves a press open when the runner wasn't reached, so the owner may press again", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      use(fakeWorld([]));
      let reached = false;
      const given = runner(async () =>
        reached ? { ok: true, applied: true } : { ok: false, reason: "unreachable" },
      );
      const { socket, press } = await told(`${MASTER}:webchat:u-owner-retry`);
      expect(await press("allow")).toBe("failed");
      reached = true;
      expect(await press("allow")).toBe("applied");
      expect(given).toEqual([
        [REQUEST, "allow"],
        [REQUEST, "allow"],
      ]);
      socket.close(1000);
    });

    it.each([
      [{ ok: false, reason: "closed" } as const, "closed"],
      [{ ok: true, applied: false } as const, "not_applied"],
    ])("says what the runner answered: %j", async (outcome, status) => {
      use(fakeWorld([]));
      runner(outcome);
      const { socket, press } = await told(`${MASTER}:webchat:u-owner-${status}`);
      expect(await press("deny")).toBe(status);
      socket.close(1000);
    });

    it("gives no verdict once the notice's 10 minutes passed", async () => {
      use(fakeWorld([]));
      const given = runner({ ok: true, applied: true });
      const name = `${MASTER}:webchat:u-owner-expired`;
      const { socket, press } = await told(name);
      const [request] = await kept(name);
      await runInDurableObject(agent(name), (_instance: ConversationAgent, state) => {
        state.storage.sql.exec(
          "UPDATE state SET value = ? WHERE key = 'sessionRequests'",
          JSON.stringify([{ ...request, expiresAt: Date.now() - REQUEST_ANSWER_MS }]),
        );
      });
      expect(await press("allow")).toBe("expired");
      expect(given).toEqual([]);
      socket.close(1000);
    });

    it("refuses a press for another agent, another request, or a socket that isn't the owner's", async () => {
      use(fakeWorld([]));
      const given = runner({ ok: true, applied: true });
      const name = `${MASTER}:webchat:u-owner-2`;
      await agent(name).ingest({
        agentId: MASTER,
        providerMessageId: `${name}-m1`,
        userId: "u-owner-2",
        role: "owner",
        chatType: "direct",
        text: "hello there, how are you doing today?",
        destination: { channel: "webchat", threadId: "u-owner-2" },
        sentAt: Date.UTC(2026, 9, 22, 17),
        timeZone: null,
      });
      const response = await agent(name).fetch("https://conversation/webchat", {
        headers: {
          Upgrade: "websocket",
          [WEBCHAT_ADMISSION_HEADER]: JSON.stringify({
            agentId: MASTER,
            userId: "u-owner-2",
            role: "member",
            chatType: "direct",
            timeZone: null,
          }),
        },
      });
      const socket = response.webSocket;
      if (!socket) throw new Error("no socket");
      const frames: Record<string, unknown>[] = [];
      socket.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
      socket.accept();
      await agent(name).sessionWait(MASTER, wait);
      expect(await kept(name)).toHaveLength(1);
      socket.send(JSON.stringify({ type: "verdict", id: REQUEST, verdict: "allow" }));
      socket.send(
        JSON.stringify({ type: "verdict", id: REQUEST, verdict: "allow", agent: "other" }),
      );
      socket.send(
        JSON.stringify({
          type: "verdict",
          id: "ffffffff-0000-4000-8000-00000000000f",
          verdict: "allow",
        }),
      );
      await vi.waitFor(() =>
        expect(
          frames.filter((frame) => frame.type === "verdict").map((frame) => frame.status),
        ).toEqual(["closed", "closed", "closed"]),
      );
      expect(given).toEqual([]);
      socket.close(1000);
    });
  });
});
