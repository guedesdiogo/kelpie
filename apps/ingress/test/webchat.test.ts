import { env, exports } from "cloudflare:workers";
import type { Admission, Verification } from "@kelpie/access";
import { WEBCHAT_ADMISSION_HEADER } from "@kelpie/conversation/contract";
import { describe, expect, it, vi } from "vitest";
import { connectWebchat, handleWebchat, type WebchatDeps } from "../src/webchat.ts";

const ORIGIN = "https://ingress.test";
const owner: Admission = { admitted: true, userId: "u-owner", role: "owner", timeZone: null };

function deps(overrides: Partial<WebchatDeps> = {}) {
  const fakes = {
    authenticate: vi.fn(async (): Promise<Verification> => ({ ok: true, sub: "access-sub" })),
    admit: vi.fn(async (): Promise<Admission> => owner),
    agentExists: vi.fn(async (agentId: string) => agentId === "assistant"),
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
