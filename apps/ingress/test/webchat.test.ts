import { env, exports } from "cloudflare:workers";
import type { Admission, Verification } from "@kelpie/access";
import type { AgentEntry } from "@kelpie/config";
import { WEBCHAT_ADMISSION_HEADER } from "@kelpie/conversation/contract";
import { describe, expect, it, vi } from "vitest";
import { connectWebchat, handleWebchat, type WebchatDeps } from "../src/webchat.ts";

const ORIGIN = "https://ingress.test";
const owner: Admission = { admitted: true, userId: "u-owner", role: "owner", timeZone: null };

/** The registry as its `list()` answers, in its order: a specialist, the main agent, and more. */
const REGISTRY: AgentEntry[] = [
  { id: "atlas", name: "Atlas", role: "specialist", owner: "assistant", chat: true },
  { id: "assistant", name: "Assistant", role: "main", owner: null, chat: true },
  { id: "agenda", name: "Agenda", role: "specialist", owner: "assistant", chat: true },
  { id: "quiet", name: "Quiet", role: "specialist", owner: "assistant", chat: false },
  { id: "helper-1", name: "Helper", role: "subagent", owner: "agenda", chat: false },
];

function deps(overrides: Partial<WebchatDeps> = {}) {
  const fakes = {
    authenticate: vi.fn(async (): Promise<Verification> => ({ ok: true, sub: "access-sub" })),
    admit: vi.fn(async (): Promise<Admission> => owner),
    agentExists: vi.fn(async (agentId: string) => agentId === "assistant"),
    listAgents: vi.fn(async () => REGISTRY),
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
        { id: "atlas", name: "Atlas", main: false },
        { id: "assistant", name: "Assistant", main: true },
        { id: "agenda", name: "Agenda", main: false },
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

  it("lists an agent from a registry before #288 that names no chat, as the Directory admits it", async () => {
    const fakes = deps({
      listAgents: vi.fn(async () => [{ id: "legacy", name: "Legacy" } as AgentEntry]),
    });
    expect(await (await handleWebchat(listRequest(), fakes)).json()).toEqual({
      agents: [{ id: "legacy", name: "Legacy", main: false }],
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
