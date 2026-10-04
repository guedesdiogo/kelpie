import { ACCESS_SOURCE, type ChannelIdentity, type IdentityStatus } from "@kelpie/access";
import { type ConfigPorts, createConfigCommands, DEFAULT_SETTINGS } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import type { Verification } from "../src/access-jwt.ts";
import { type AdminDeps, handle } from "../src/api.ts";

const OWNER_SUB = "sub-owner";
const NOW_MS = 1_791_000_000_000;
const TOKEN = `${NOW_MS / 1_000 + 3_600}.${"c0ffee".repeat(6)}`;

/** A world with a Directory that knows `subs` and an in-memory agent registry. */
function world({
  owner = true,
  authenticated = OWNER_SUB as string | null,
  role = "owner" as "owner" | "member",
} = {}) {
  const identities = new Map<string, { userId: string; status: IdentityStatus }>();
  const key = (identity: ChannelIdentity) => `${identity.channel}:${identity.channelUserId}`;
  let ownerId: string | null = null;
  if (owner) {
    ownerId = "u-owner";
    identities.set(`${ACCESS_SOURCE}:${OWNER_SUB}`, { userId: ownerId, status: "enabled" });
  }
  const agents = new Map<string, string>();
  const ran: string[] = [];
  const ports: ConfigPorts = {
    registry: {
      async add(id, name) {
        ran.push("registry.add");
        if (agents.has(id)) return { ok: true, created: false };
        agents.set(id, name);
        return { ok: true, created: true };
      },
      async rename() {
        return { ok: false, reason: "unknown_agent" };
      },
      async get(id) {
        const name = agents.get(id);
        return name ? { id, name } : null;
      },
      async list() {
        ran.push("registry.list");
        return [...agents].map(([id, name]) => ({ id, name }));
      },
    },
    agents: {
      async configure() {
        return { ok: true, value: { settings: DEFAULT_SETTINGS, promptVersion: 0 } };
      },
      async config() {
        return { settings: DEFAULT_SETTINGS, promptVersion: 0 };
      },
    },
    directory: {
      async addIdentity() {
        return { ok: false, reason: "identity_taken" };
      },
      async enableIdentity() {
        return { ok: false, reason: "unknown_identity" };
      },
      async disableIdentity() {
        return { ok: true, status: "disabled" };
      },
      async listIdentities() {
        return [];
      },
    },
  };
  const bootstraps: { userId: string; accessSub: string }[] = [];
  const deps: AdminDeps = {
    async authenticate(): Promise<Verification> {
      return authenticated ? { ok: true, sub: authenticated } : { ok: false, reason: "signature" };
    },
    directory: {
      async admit(identity) {
        const found = identities.get(key(identity));
        if (found?.status !== "enabled") {
          return { admitted: false, reason: "unknown_identity" };
        }
        return { admitted: true, userId: found.userId, role };
      },
      async ownerExists() {
        return ownerId !== null;
      },
      async bootstrapOwner(userId, accessSub) {
        if (ownerId) return { ok: false, reason: "owner_exists" };
        ownerId = userId;
        bootstraps.push({ userId, accessSub });
        identities.set(`${ACCESS_SOURCE}:${accessSub}`, { userId, status: "enabled" });
        return { ok: true };
      },
    },
    commands: createConfigCommands(ports),
    bootstrapToken: TOKEN,
    now: () => NOW_MS,
    newUserId: () => "u-new",
  };
  return { deps, ran, bootstraps };
}

function post(path: string, body?: unknown) {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`https://admin.example${path}`, init);
}

async function call(deps: AdminDeps, path: string, body?: unknown) {
  const response = await handle(post(path, body), deps);
  return { status: response.status, body: await response.json() };
}

describe("admin API commands", () => {
  it("runs a command for the owner and answers its result", async () => {
    const { deps } = world();
    expect(await call(deps, "/commands/createAgent", { id: "sales", name: "Sales" })).toEqual({
      status: 200,
      body: { ok: true, value: { id: "sales", name: "Sales", created: true } },
    });
    expect(await call(deps, "/commands/listAgents")).toEqual({
      status: 200,
      body: { ok: true, value: [{ id: "sales", name: "Sales" }] },
    });
  });

  it("refuses a request whose Access JWT doesn't verify, before running anything", async () => {
    const { deps, ran } = world({ authenticated: null });
    expect(await call(deps, "/commands/listAgents")).toEqual({
      status: 401,
      body: { ok: false, reason: "unauthenticated" },
    });
    expect(ran).toEqual([]);
  });

  it("answers 503 when Access's keys can't be loaded", async () => {
    const { deps } = world();
    deps.authenticate = async () => {
      throw new Error("Access keys returned 502");
    };
    expect(await call(deps, "/commands/listAgents")).toEqual({
      status: 503,
      body: { ok: false, reason: "unavailable" },
    });
  });

  it("tells an unknown Access login apart from a missing owner", async () => {
    const stranger = world({ authenticated: "sub-stranger" });
    expect(await call(stranger.deps, "/commands/listAgents")).toEqual({
      status: 403,
      body: { ok: false, reason: "forbidden" },
    });
    expect(stranger.ran).toEqual([]);

    const fresh = world({ owner: false });
    expect(await call(fresh.deps, "/commands/listAgents")).toEqual({
      status: 403,
      body: { ok: false, reason: "no_owner" },
    });
  });

  it("lets the commands refuse an admitted caller who isn't the owner", async () => {
    const { deps, ran } = world({ role: "member" });
    expect(await call(deps, "/commands/listAgents")).toEqual({
      status: 403,
      body: { ok: false, reason: "forbidden" },
    });
    expect(ran).toEqual([]);
  });

  it.each([
    ["an invalid input", "/commands/createAgent", { id: "Sales Team", name: "x" }, 400],
    ["an unknown agent", "/commands/renameAgent", { id: "ghost", name: "Nobody" }, 404],
    [
      "an identity someone else holds",
      "/commands/addIdentity",
      { channel: "telegram", channelUserId: "1" },
      409,
    ],
  ])("maps %s to its HTTP status", async (_label, path, body, status) => {
    const { deps } = world();
    expect((await call(deps, path, body)).status).toBe(status);
  });

  it.each([
    ["an unknown command", "POST", "/commands/dropTables"],
    ["a prototype key as a command", "POST", "/commands/constructor"],
    ["another path", "POST", "/agents"],
    ["an empty command", "POST", "/commands/"],
    ["the bootstrap with a trailing slash", "POST", "/bootstrap/"],
    ["a GET", "GET", "/commands/listAgents"],
  ])("answers 404 to %s", async (_label, method, path) => {
    const { deps, ran } = world();
    const response = await handle(new Request(`https://admin.example${path}`, { method }), deps);
    expect(response.status).toBe(404);
    expect(ran).toEqual([]);
  });

  it("answers 500 without details when an object fails", async () => {
    const { deps } = world();
    deps.directory.admit = async () => {
      throw new Error("Durable Object reset: owner@example.com");
    };
    expect(await call(deps, "/commands/listAgents")).toEqual({
      status: 500,
      body: { ok: false, reason: "internal" },
    });
  });

  it("stops reading a body past the cap, whatever its Content-Length says", async () => {
    const { deps, ran } = world();
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await handle(
      new Request("https://admin.example/commands/createAgent", {
        method: "POST",
        headers: { "content-length": "10" },
        body,
      }),
      deps,
    );
    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(10);
    expect(ran).toEqual([]);
  });

  it("refuses a body that isn't JSON, or one too large", async () => {
    const { deps } = world();
    expect(await call(deps, "/commands/createAgent", "{not json")).toEqual({
      status: 400,
      body: { ok: false, reason: "invalid_json" },
    });
    expect(
      (await call(deps, "/commands/configureAgent", { prompt: "x".repeat(70_000) })).status,
    ).toBe(413);
  });
});

describe("admin API first-run bootstrap", () => {
  it("makes the Access login with the deploy token the owner, once", async () => {
    const { deps, bootstraps } = world({ owner: false });

    expect(await call(deps, "/bootstrap", { token: TOKEN })).toEqual({
      status: 201,
      body: { ok: true },
    });
    expect(bootstraps).toEqual([{ userId: "u-new", accessSub: OWNER_SUB }]);
    expect((await call(deps, "/commands/listAgents")).status).toBe(200);

    // Disabled from now on, even with the right token.
    expect(await call(deps, "/bootstrap", { token: TOKEN })).toEqual({
      status: 410,
      body: { ok: false, reason: "bootstrap_disabled" },
    });
  });

  it.each([
    ["a wrong token", { token: `${NOW_MS / 1_000 + 3_600}.${"decaf0".repeat(6)}` }],
    ["no token", {}],
    ["a token that isn't a string", { token: 42 }],
  ])("refuses %s", async (_label, body) => {
    const { deps, bootstraps } = world({ owner: false });
    expect(await call(deps, "/bootstrap", body)).toEqual({
      status: 403,
      body: { ok: false, reason: "invalid_bootstrap_token" },
    });
    expect(bootstraps).toEqual([]);
  });

  it("refuses once the configured token has expired, or when none is configured", async () => {
    const expired = world({ owner: false });
    expired.deps.now = () => NOW_MS + 3_601_000;
    expect((await call(expired.deps, "/bootstrap", { token: TOKEN })).status).toBe(403);

    const unset = world({ owner: false });
    unset.deps.bootstrapToken = undefined;
    expect((await call(unset.deps, "/bootstrap", { token: TOKEN })).status).toBe(403);
  });

  it.each([
    ["without an expiry", "c0ffee".repeat(6)],
    ["with a short secret", `${NOW_MS / 1_000 + 3_600}.c0ffee`],
    ["with an expiry that isn't digits", `1e15.${"c0ffee".repeat(6)}`],
  ])("never accepts a configured token %s", async (_label, configured) => {
    const { deps, bootstraps } = world({ owner: false });
    deps.bootstrapToken = configured;
    expect((await call(deps, "/bootstrap", { token: configured })).status).toBe(403);
    expect(bootstraps).toEqual([]);
  });

  it("needs a verified Access login, like every other request", async () => {
    const { deps, bootstraps } = world({ owner: false, authenticated: null });
    expect((await call(deps, "/bootstrap", { token: TOKEN })).status).toBe(401);
    expect(bootstraps).toEqual([]);
  });
});
