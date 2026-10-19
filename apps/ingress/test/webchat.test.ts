import { env, exports } from "cloudflare:workers";
import type { Admission, Verification } from "@kelpie/access";
import { type Actor, type AgentEntry, KELPIE_MASCOT, type Mascot } from "@kelpie/config";
import { WEBCHAT_ADMISSION_HEADER } from "@kelpie/conversation/contract";
import { describe, expect, it, vi } from "vitest";
import {
  connectWebchat,
  handleAgentEdit,
  handleWebchat,
  MASCOTS_WITHIN_MS,
  type WebchatDeps,
} from "../src/webchat.ts";

const ORIGIN = "https://ingress.test";
const owner: Admission = { admitted: true, userId: "u-owner", role: "owner", timeZone: null };

/** The registry as its `list()` answers, in its order: a specialist, Master, and more. */
const REGISTRY: AgentEntry[] = [
  { id: "atlas", name: "Atlas", role: "specialist", owner: "assistant", chat: true },
  { id: "assistant", name: "Assistant", role: "master", owner: null, chat: true },
  { id: "agenda", name: "Agenda", role: "specialist", owner: "assistant", chat: true },
  { id: "quiet", name: "Quiet", role: "specialist", owner: "assistant", chat: false },
  { id: "helper-1", name: "Helper", role: "subagent", owner: "agenda", chat: false },
];

/** The AgentEditor as conversation-runtime answers, keeping what it was asked to set. */
function editorFake() {
  const done = <T>(value: T) => ({ ok: true as const, value });
  return {
    setMascot: vi.fn(async (_actor: Actor, _id: string, mascot: unknown) => done(mascot as Mascot)),
    rename: vi.fn(async (_actor: Actor, _id: string, name: unknown) => done(String(name).trim())),
    setRemit: vi.fn(async (_actor: Actor, _id: string, remit: unknown) => done(String(remit))),
    setSpecialty: vi.fn(async (_actor: Actor, _id: string, specialty: unknown) =>
      done(String(specialty)),
    ),
  } satisfies WebchatDeps["editor"];
}

function deps(overrides: Partial<WebchatDeps> = {}) {
  const fakes = {
    authenticate: vi.fn(async (): Promise<Verification> => ({ ok: true, sub: "access-sub" })),
    admit: vi.fn(async (): Promise<Admission> => owner),
    agentExists: vi.fn(async (agentId: string) => agentId === "assistant"),
    listAgents: vi.fn(async () => REGISTRY),
    looks: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
    editor: editorFake(),
    page: vi.fn(async () => new Response("<!doctype html>", { status: 200 })),
    connect: vi.fn(async () => new Response("socket", { status: 200 })),
    ...overrides,
  };
  return fakes;
}

const socketRequest = (
  path = "/webchat/ws?agent=assistant",
  headers: Record<string, string> = {},
) =>
  new Request(`${ORIGIN}${path}`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN, ...headers },
  });

describe("the webchat's page", () => {
  it("is served behind the owner's Access login, with a strict content policy", async () => {
    const fakes = deps();
    const response = await handleWebchat(new Request(`${ORIGIN}/webchat/`), fakes);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Some Safari versions don't match 'self' to wss:, so the socket's origin is named.
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self' wss://ingress.test",
    );
    // The mascot's fur is painted in the page and shown as blob: images (ADR-0045 §8); nothing
    // else loads an image from elsewhere.
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self' blob:;");
    expect(response.headers.get("content-security-policy")).not.toContain("data:");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fakes.page).toHaveBeenCalledOnce();
  });

  it("answers 404 while Access isn't configured, so the webchat stays off", async () => {
    const fakes = deps({ authenticate: async () => ({ ok: false, reason: "not_configured" }) });
    expect((await handleWebchat(new Request(`${ORIGIN}/webchat/`), fakes)).status).toBe(404);
    expect((await handleWebchat(socketRequest(), fakes)).status).toBe(404);
    expect(fakes.page).not.toHaveBeenCalled();
    expect(fakes.connect).not.toHaveBeenCalled();
  });

  it("refuses a request without a valid Access token", async () => {
    const fakes = deps({ authenticate: async () => ({ ok: false, reason: "signature" }) });
    expect((await handleWebchat(new Request(`${ORIGIN}/webchat/`), fakes)).status).toBe(403);
    expect((await handleWebchat(socketRequest(), fakes)).status).toBe(403);
    expect(fakes.admit).not.toHaveBeenCalled();
  });
});

describe("the webchat's fonts", () => {
  it("are kept by the browser for a year, since their names change with their version", async () => {
    const fakes = deps({
      page: vi.fn(async () => new Response("woff2", { status: 200 })),
    });
    const font = await handleWebchat(
      new Request(`${ORIGIN}/webchat/fonts/geist-latin-wght-5.3.0.woff2`),
      fakes,
    );
    expect(font.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    // A font that isn't there isn't remembered as missing.
    const missing = await handleWebchat(
      new Request(`${ORIGIN}/webchat/fonts/gone-1.0.0.woff2`),
      deps({ page: vi.fn(async () => new Response("not found", { status: 404 })) }),
    );
    expect(missing.headers.get("cache-control")).toBe("no-store");
    // Everything else changes with a deploy under the same name.
    for (const path of ["/webchat/", "/webchat/app.js", "/webchat/fonts.css"]) {
      const response = await handleWebchat(new Request(`${ORIGIN}${path}`), fakes);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("the webchat's agent list", () => {
  const listRequest = (headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/webchat/agents`, { headers });

  it("lists the agents that chat, in the registry's order, to an identity the Directory admits", async () => {
    const fakes = deps();
    const response = await handleWebchat(listRequest(), fakes);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      agents: [
        { id: "atlas", name: "Atlas", master: false },
        { id: "assistant", name: "Assistant", master: true },
        { id: "agenda", name: "Agenda", master: false },
      ],
    });
    // Each agent is admitted as its socket would be; the ones that don't chat aren't asked about.
    expect(vi.mocked(fakes.admit).mock.calls.map(([, agentId]) => agentId)).toEqual([
      "atlas",
      "assistant",
      "agenda",
    ]);
    expect(fakes.admit).toHaveBeenCalledWith(
      { channel: "cloudflare-access", channelUserId: "access-sub" },
      "assistant",
    );
    expect(fakes.page).not.toHaveBeenCalled();
  });

  it("names each admitted agent's mascot, as AgentLooks reads it, and only a valid one (ADR-0052 §7)", async () => {
    const fakes = deps({
      looks: vi.fn(async () => ({
        assistant: { mascot: KELPIE_MASCOT },
        agenda: { mascot: { ...KELPIE_MASCOT, shape: "<img src=x onerror=alert(1)>" } },
      })),
    });
    const { agents } = (await (await handleWebchat(listRequest(), fakes)).json()) as {
      agents: unknown[];
    };
    expect(fakes.looks).toHaveBeenCalledWith(["atlas", "assistant", "agenda"]);
    expect(agents).toEqual([
      { id: "atlas", name: "Atlas", master: false },
      { id: "assistant", name: "Assistant", master: true, mascot: KELPIE_MASCOT },
      { id: "agenda", name: "Agenda", master: false },
    ]);
  });

  it("names each agent's specialty and remit for its editor, as one line each (#379)", async () => {
    const fakes = deps({
      looks: vi.fn(async () => ({
        assistant: { mascot: KELPIE_MASCOT, specialty: "", remit: "Your day." },
        agenda: { mascot: KELPIE_MASCOT, specialty: "Agenda e e-mail", remit: "Meetings." },
        atlas: { mascot: KELPIE_MASCOT, specialty: 7, remit: "a".repeat(300) },
      })),
    });
    const { agents } = (await (await handleWebchat(listRequest(), fakes)).json()) as {
      agents: unknown[];
    };
    expect(agents).toEqual([
      { id: "atlas", name: "Atlas", master: false, mascot: KELPIE_MASCOT },
      {
        id: "assistant",
        name: "Assistant",
        master: true,
        mascot: KELPIE_MASCOT,
        specialty: "",
        remit: "Your day.",
      },
      {
        id: "agenda",
        name: "Agenda",
        master: false,
        mascot: KELPIE_MASCOT,
        specialty: "Agenda e e-mail",
        remit: "Meetings.",
      },
    ]);
  });

  it("lists the agents without their mascots when AgentLooks fails", async () => {
    const fakes = deps({
      looks: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const response = await handleWebchat(listRequest(), fakes);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { agents: unknown[] }).agents).toHaveLength(3);
  });

  it("lists the agents without their mascots when AgentLooks is slow", async () => {
    const fakes = deps({ looks: vi.fn(() => new Promise<Record<string, unknown>>(() => {})) });
    const started = Date.now();
    const response = await handleWebchat(listRequest(), fakes);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { agents: { mascot?: unknown }[] }).agents).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(MASCOTS_WITHIN_MS + 1_000);
  });

  it("lists an agent from a registry before #288 that names no chat, as the Directory admits it", async () => {
    const fakes = deps({
      listAgents: vi.fn(async () => [{ id: "legacy", name: "Legacy" } as AgentEntry]),
    });
    expect(await (await handleWebchat(listRequest(), fakes)).json()).toEqual({
      agents: [{ id: "legacy", name: "Legacy", master: false }],
    });
  });

  it("leaves out an agent the Directory doesn't admit this identity to", async () => {
    const fakes = deps({
      admit: vi.fn(
        async (_identity: unknown, agentId: string): Promise<Admission> =>
          agentId === "agenda" ? { admitted: false, reason: "no_grant" } : owner,
      ),
    });
    const { agents } = (await (await handleWebchat(listRequest(), fakes)).json()) as {
      agents: { id: string }[];
    };
    expect(agents.map((agent) => agent.id)).toEqual(["atlas", "assistant"]);
  });

  it("names no agent to an Access login the Directory admits to none", async () => {
    const fakes = deps({
      admit: vi.fn(
        async (): Promise<Admission> => ({ admitted: false, reason: "unknown_identity" }),
      ),
    });
    const response = await handleWebchat(listRequest(), fakes);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it("asks for a valid Access login first, as the page does", async () => {
    const off = deps({ authenticate: async () => ({ ok: false, reason: "not_configured" }) });
    expect((await handleWebchat(listRequest(), off)).status).toBe(404);
    const invalid = deps({ authenticate: async () => ({ ok: false, reason: "expired" }) });
    expect((await handleWebchat(listRequest(), invalid)).status).toBe(403);
    expect(invalid.listAgents).not.toHaveBeenCalled();
    expect(invalid.admit).not.toHaveBeenCalled();
  });
});

describe("the webchat's socket", () => {
  it("admits the owner's Access identity and opens the agent's webchat conversation", async () => {
    const fakes = deps();
    const response = await handleWebchat(socketRequest(), fakes);

    expect(await response.text()).toBe("socket");
    expect(fakes.admit).toHaveBeenCalledWith(
      { channel: "cloudflare-access", channelUserId: "access-sub" },
      "assistant",
    );
    expect(fakes.connect).toHaveBeenCalledWith("assistant:webchat:u-owner", {
      agentId: "assistant",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      timeZone: null,
    });
  });

  it("hands the conversation the browser's language, as the page names it or its header says (#187)", async () => {
    const named = deps();
    await handleWebchat(
      socketRequest("/webchat/ws?agent=assistant&lang=es-AR", { "Accept-Language": "pt-BR" }),
      named,
    );
    expect(named.connect).toHaveBeenCalledWith(
      "assistant:webchat:u-owner",
      expect.objectContaining({ language: "es-AR" }),
    );
    const header = deps();
    await handleWebchat(socketRequest(undefined, { "Accept-Language": "pt-BR,pt;q=0.9" }), header);
    expect(header.connect).toHaveBeenCalledWith(
      "assistant:webchat:u-owner",
      expect.objectContaining({ language: "pt-BR,pt;q=0.9" }),
    );
    // A browser that names no language sends an empty one: the header says instead.
    const empty = deps();
    await handleWebchat(
      socketRequest("/webchat/ws?agent=assistant&lang=", { "Accept-Language": "es" }),
      empty,
    );
    expect(empty.connect).toHaveBeenCalledWith(
      "assistant:webchat:u-owner",
      expect.objectContaining({ language: "es" }),
    );
    const long = deps();
    await handleWebchat(socketRequest(`/webchat/ws?agent=assistant&lang=${"x".repeat(500)}`), long);
    expect(long.connect).toHaveBeenCalledWith(
      "assistant:webchat:u-owner",
      expect.objectContaining({ language: "x".repeat(200) }),
    );
  });

  it("opens the sidebar's presence view, admitted the same way, and refuses a view it doesn't know (ADR-0052 §1)", async () => {
    const fakes = deps();
    await handleWebchat(socketRequest("/webchat/ws?agent=assistant&view=presence"), fakes);
    expect(fakes.admit).toHaveBeenCalledOnce();
    expect(fakes.connect).toHaveBeenCalledWith("assistant:webchat:u-owner", {
      agentId: "assistant",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      timeZone: null,
      view: "presence",
    });

    const other = deps();
    const unknown = await handleWebchat(
      socketRequest("/webchat/ws?agent=assistant&view=all"),
      other,
    );
    expect(unknown.status).toBe(400);
    expect(other.admit).not.toHaveBeenCalled();
    expect(other.connect).not.toHaveBeenCalled();

    // The page's origin is checked first, whatever the view.
    const elsewhere = deps();
    const foreign = socketRequest("/webchat/ws?agent=assistant&view=presence", {
      Origin: "https://evil.example",
    });
    expect((await handleWebchat(foreign, elsewhere)).status).toBe(403);
    expect(elsewhere.admit).not.toHaveBeenCalled();
  });

  it("refuses a socket from another origin, or with no origin", async () => {
    const fakes = deps();
    const elsewhere = socketRequest(undefined, { Origin: "https://evil.example" });
    expect((await handleWebchat(elsewhere, fakes)).status).toBe(403);
    const none = new Request(`${ORIGIN}/webchat/ws?agent=assistant`, {
      headers: { Upgrade: "websocket" },
    });
    expect((await handleWebchat(none, fakes)).status).toBe(403);
    expect(fakes.connect).not.toHaveBeenCalled();
  });

  it("refuses an agent id that isn't one, and an identity the Directory doesn't admit", async () => {
    const fakes = deps();
    expect(
      (await handleWebchat(socketRequest("/webchat/ws?agent=Not%20an%20id"), fakes)).status,
    ).toBe(404);
    expect((await handleWebchat(socketRequest("/webchat/ws"), fakes)).status).toBe(404);

    const refused = deps({
      admit: async () => ({ admitted: false, reason: "unknown_identity" }),
    });
    expect((await handleWebchat(socketRequest(), refused)).status).toBe(403);
    expect(refused.connect).not.toHaveBeenCalled();
  });

  it("refuses an agent that isn't registered, before asking the Directory", async () => {
    const fakes = deps();
    expect((await handleWebchat(socketRequest("/webchat/ws?agent=nobody"), fakes)).status).toBe(
      404,
    );
    expect(fakes.admit).not.toHaveBeenCalled();
    expect(fakes.connect).not.toHaveBeenCalled();
  });

  it("answers 426 to a plain request on the socket path", async () => {
    const fakes = deps();
    const plain = new Request(`${ORIGIN}/webchat/ws?agent=assistant`, {
      headers: { Origin: ORIGIN },
    });
    expect((await handleWebchat(plain, fakes)).status).toBe(426);
  });

  it("hands the conversation only the admission ingress built, never the browser's headers", async () => {
    const response = await connectWebchat(env, "assistant:webchat:u-owner", {
      agentId: "assistant",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      timeZone: "America/Sao_Paulo",
    });
    const socket = response.webSocket;
    if (!socket) throw new Error(`no socket: ${response.status}`);
    const frames: string[] = [];
    socket.addEventListener("message", (event) => frames.push(String(event.data)));
    socket.accept();

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const seen = JSON.parse(frames[0] ?? "{}") as Record<string, string>;
    expect(JSON.parse(seen[WEBCHAT_ADMISSION_HEADER] ?? "null")).toEqual({
      agentId: "assistant",
      userId: "u-owner",
      role: "owner",
      chatType: "direct",
      timeZone: "America/Sao_Paulo",
    });
    expect(Object.keys(seen).sort()).toEqual([WEBCHAT_ADMISSION_HEADER, "upgrade"].sort());
  });
});

describe("the webchat's route", () => {
  it("answers 404 in production wiring while Access isn't configured", async () => {
    for (const path of ["/webchat", "/webchat/", "/webchat/ws?agent=assistant"]) {
      const response = await exports.default.fetch(`${ORIGIN}${path}`, {
        headers: { Upgrade: "websocket", Origin: ORIGIN },
      });
      expect(response.status).toBe(404);
    }
  });
});

describe("the webchat's agent editor (#379)", () => {
  const PICKED: Mascot = { ...KELPIE_MASCOT, shape: "star", color: "pink" };
  const edit = (
    path: string,
    body: unknown,
    { headers = {}, method = "PUT" }: { headers?: Record<string, string>; method?: string } = {},
  ) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const mascotOf = (agent = "assistant", body: unknown = PICKED, options = {}) =>
    edit(`/webchat/agents/${agent}/mascot`, body, options);
  const profileOf = (body: unknown, agent = "assistant") =>
    edit(`/webchat/agents/${agent}/profile`, body);
  const owned = { userId: "u-owner", role: "owner", via: "webchat" };

  it("saves the owner's mascot, whole, as the actor the Directory resolved", async () => {
    const fakes = deps();
    const response = await handleAgentEdit(mascotOf(), fakes);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ mascot: PICKED });
    expect(fakes.admit).toHaveBeenCalledWith(
      { channel: "cloudflare-access", channelUserId: "access-sub" },
      "assistant",
    );
    expect(fakes.editor.setMascot).toHaveBeenCalledWith(owned, "assistant", PICKED);
  });

  it("saves the profile's fields the page sends, the specialty first, and answers what they now are", async () => {
    const fakes = deps();
    const response = await handleAgentEdit(
      profileOf({ name: " Agenda ", remit: "Meetings.", specialty: "Agenda e e-mail" }),
      fakes,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "Agenda",
      remit: "Meetings.",
      specialty: "Agenda e e-mail",
    });
    const order = [
      vi.mocked(fakes.editor.setSpecialty).mock.invocationCallOrder[0],
      vi.mocked(fakes.editor.setRemit).mock.invocationCallOrder[0],
      vi.mocked(fakes.editor.rename).mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)));

    const one = deps();
    expect(await (await handleAgentEdit(profileOf({ remit: "" }), one)).json()).toEqual({
      remit: "",
    });
    expect(one.editor.rename).not.toHaveBeenCalled();
    expect(one.editor.setSpecialty).not.toHaveBeenCalled();
  });

  it("refuses a request without a valid Access login, as the page does", async () => {
    const off = deps({ authenticate: async () => ({ ok: false, reason: "not_configured" }) });
    expect((await handleAgentEdit(mascotOf(), off)).status).toBe(404);
    const expired = deps({ authenticate: async () => ({ ok: false, reason: "expired" }) });
    expect((await handleAgentEdit(mascotOf(), expired)).status).toBe(403);
    expect(expired.admit).not.toHaveBeenCalled();
    expect(expired.editor.setMascot).not.toHaveBeenCalled();
  });

  it.each([
    ["another origin", { Origin: "https://evil.test" }],
    ["no origin", { Origin: "" }],
    ["a cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
    ["a same-site fetch from another origin", { "Sec-Fetch-Site": "same-site" }],
    ["no fetch metadata", { "Sec-Fetch-Site": "" }],
  ])("refuses %s, before reading anything", async (_label, headers) => {
    const fakes = deps();
    const response = await handleAgentEdit(mascotOf("assistant", PICKED, { headers }), fakes);
    expect(response.status).toBe(403);
    expect(fakes.admit).not.toHaveBeenCalled();
    expect(fakes.editor.setMascot).not.toHaveBeenCalled();
  });

  it("refuses anyone the Directory doesn't resolve to the owner of an agent it admits", async () => {
    const member = deps({
      admit: vi.fn(
        async (): Promise<Admission> => ({
          admitted: true,
          userId: "u-member",
          role: "member",
          timeZone: null,
        }),
      ),
    });
    expect((await handleAgentEdit(mascotOf(), member)).status).toBe(403);
    expect(member.editor.setMascot).not.toHaveBeenCalled();
    const stranger = deps({
      admit: vi.fn(async (): Promise<Admission> => ({ admitted: false, reason: "no_grant" })),
    });
    expect((await handleAgentEdit(mascotOf(), stranger)).status).toBe(403);
    expect(stranger.editor.setMascot).not.toHaveBeenCalled();
  });

  it("refuses an agent the registry doesn't list, or an id that isn't one", async () => {
    const fakes = deps();
    for (const agent of ["ghost", "Assistant", "../assistant", "%2e%2e"]) {
      expect((await handleAgentEdit(mascotOf(agent), fakes)).status, agent).toBe(404);
    }
    expect((await handleAgentEdit(edit("/webchat/agents/assistant/soul", {}), fakes)).status).toBe(
      404,
    );
    expect(fakes.admit).not.toHaveBeenCalled();
  });

  it.each([
    ["a shape it doesn't know", { ...KELPIE_MASCOT, shape: "triangle" }],
    ["another setting beside it", { ...KELPIE_MASCOT, tier: "frontier" }],
    ["a mascot wrapped in another field", { mascot: KELPIE_MASCOT }],
    ["null, which would go back to the default", null],
    ["text that isn't JSON", "{not json"],
  ])("refuses %s as a mascot", async (_label, body) => {
    const fakes = deps();
    expect((await handleAgentEdit(mascotOf("assistant", body), fakes)).status).toBe(400);
    expect(fakes.editor.setMascot).not.toHaveBeenCalled();
  });

  it.each([
    ["no field", {}],
    ["a field it doesn't take", { name: "Agenda", tier: "frontier" }],
    ["a name that breaks the line", { name: "Two\nlines" }],
    ["a name that shows nothing", { name: "   " }],
    ["a remit that is too long", { remit: "a".repeat(201) }],
    ["a specialty that is too long", { specialty: "a".repeat(41) }],
    ["a field that isn't text", { remit: 7 }],
    ["a list", [{ name: "Agenda" }]],
  ])("refuses %s as a profile, before changing any field", async (_label, body) => {
    const fakes = deps();
    expect((await handleAgentEdit(profileOf(body), fakes)).status).toBe(400);
    expect(fakes.editor.rename).not.toHaveBeenCalled();
    expect(fakes.editor.setRemit).not.toHaveBeenCalled();
    expect(fakes.editor.setSpecialty).not.toHaveBeenCalled();
  });

  it("takes only a JSON PUT of a small body", async () => {
    const fakes = deps();
    const text = await handleAgentEdit(
      mascotOf("assistant", PICKED, { headers: { "Content-Type": "text/plain" } }),
      fakes,
    );
    expect(text.status).toBe(415);
    const big = await handleAgentEdit(profileOf({ remit: "a".repeat(5_000) }), deps());
    expect(big.status).toBe(413);
    expect(fakes.editor.setMascot).not.toHaveBeenCalled();
  });

  it("reads at most 4 KB of a body, counted in bytes, even with no Content-Length", async () => {
    // A stream that names no length: each pull hands over 1 KB, and counts it.
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(new TextEncoder().encode("a".repeat(1_024)));
      },
    });
    const request = new Request(`${ORIGIN}/webchat/agents/assistant/profile`, {
      method: "PUT",
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: stream,
    });
    expect(request.headers.get("content-length")).toBeNull();
    const fakes = deps();
    expect((await handleAgentEdit(request, fakes)).status).toBe(413);
    expect(pulled).toBeLessThan(10);
    // Two bytes a letter: 2,100 of them pass a count of characters, not of bytes.
    expect((await handleAgentEdit(profileOf({ remit: "ç".repeat(2_100) }), deps())).status).toBe(
      413,
    );
    expect(fakes.editor.setRemit).not.toHaveBeenCalled();
  });

  it("reads no body for a login the Directory doesn't resolve to the owner", async () => {
    const member = deps({
      admit: vi.fn(
        async (): Promise<Admission> => ({
          admitted: true,
          userId: "u-member",
          role: "member",
          timeZone: null,
        }),
      ),
    });
    const request = mascotOf();
    expect((await handleAgentEdit(request, member)).status).toBe(403);
    expect(request.bodyUsed).toBe(false);
  });

  it("says which profile fields saved when a later one fails, and checks what the editor answers", async () => {
    const failing = deps({
      editor: {
        ...editorFake(),
        rename: vi.fn(async () => {
          throw new Error("Registry unavailable");
        }),
      },
    });
    const response = await handleAgentEdit(
      profileOf({ name: "Agendas", remit: "Meetings.", specialty: "Agenda" }),
      failing,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ saved: { specialty: "Agenda", remit: "Meetings." } });
    // A value that isn't a mascot never goes back to the page.
    const odd = deps({
      editor: {
        ...editorFake(),
        setMascot: vi.fn(async () => ({ ok: true, value: { shape: "<b>" } }) as never),
      },
    });
    expect((await handleAgentEdit(mascotOf(), odd)).status).toBe(503);
  });

  it("answers the editor's refusals with their status, and says so for Master's specialty", async () => {
    const refusing = (reason: string) =>
      deps({
        editor: {
          ...editorFake(),
          setMascot: vi.fn(async () => ({ ok: false, reason }) as never),
          setSpecialty: vi.fn(async () => ({ ok: false, reason }) as never),
        },
      });
    expect((await handleAgentEdit(mascotOf(), refusing("forbidden"))).status).toBe(403);
    expect((await handleAgentEdit(mascotOf(), refusing("unknown_agent"))).status).toBe(404);
    expect((await handleAgentEdit(mascotOf(), refusing("invalid_input"))).status).toBe(400);
    const master = refusing("not_allowed");
    expect(
      (await handleAgentEdit(profileOf({ specialty: "Agenda", name: "Kelpie" }), master)).status,
    ).toBe(409);
    // The field refused first: nothing after it was asked.
    expect(master.editor.rename).not.toHaveBeenCalled();
    const down = deps({
      editor: {
        ...editorFake(),
        setMascot: vi.fn(async () => {
          throw new Error("conversation-runtime is down");
        }),
      },
    });
    expect((await handleAgentEdit(mascotOf(), down)).status).toBe(503);
  });
});

describe("the agent editor's route", () => {
  it("answers 404 in production wiring while Access isn't configured", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/webchat/agents/assistant/mascot`, {
      method: "PUT",
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(KELPIE_MASCOT),
    });
    expect(response.status).toBe(404);
  });
});
