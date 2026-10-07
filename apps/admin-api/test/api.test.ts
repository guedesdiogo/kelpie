import type { Verification } from "@kelpie/access";
import { ACCESS_SOURCE, type ChannelIdentity, type IdentityStatus } from "@kelpie/access";
import { type ConfigPorts, createConfigCommands, DEFAULT_SETTINGS } from "@kelpie/config";
import { describe, expect, it, vi } from "vitest";
import { type AdminDeps, handle } from "../src/api.ts";

const OWNER_SUB = "sub-owner";
const GOOD_BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw-test";
const NOW_MS = 1_791_000_000_000;
const TOKEN = `${NOW_MS / 1_000 + 3_600}.${"c0ffee".repeat(6)}`;
const RECOVERY = `${NOW_MS / 1_000 + 3_600}.${"5eed".repeat(8)}`;

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
      async issuePairingCode() {
        ran.push("directory.issuePairingCode");
        return { ok: true, code: "ABCD2345", expiresAt: NOW_MS + 3_600_000 };
      },
      async enableIdentity(identity) {
        return identity.channelUserId === "pending"
          ? { ok: false, reason: "not_paired" }
          : { ok: false, reason: "unknown_identity" };
      },
      async disableIdentity() {
        return { ok: true, status: "disabled" };
      },
      async listIdentities() {
        return [];
      },
      async setTimeZone(_userId, timeZone) {
        return { ok: true, timeZone };
      },
    },
    channels: {
      async createTelegramForm() {
        return { ok: true, token: "form-token-1", expiresAt: NOW_MS + 900_000 };
      },
      async describeTelegramBot(agentId) {
        return agentId === "unwired"
          ? { ok: false, reason: "not_connected" }
          : { ok: true, username: "kelpie_bot" };
      },
      async registerTelegramWebhook(agentId) {
        return agentId === "unwired" ? { ok: false, reason: "not_connected" } : { ok: true };
      },
    },
    vault: {
      async held() {
        return [{ path: "memory/people/ana.md", state: "proposed", attempts: 1, at: NOW_MS }];
      },
      async forget(paths) {
        return { ok: true, forgotten: paths.length, stillInVault: [] };
      },
      async setDream(mode) {
        return { ok: true, mode };
      },
    },
  };
  const bootstraps: { userId: string; accessSub: string }[] = [];
  const relinks: { accessSub: string; tokenHash: string }[] = [];
  const spentTokens = new Set<string>();
  /** Open forms by token; a redeemed or burned form disappears. */
  const forms = new Map<string, { agentId: string; refusals: number }>([
    ["form-token-1", { agentId: "sales", refusals: 0 }],
    ["form-odd", { agentId: "<i>odd</i>", refusals: 0 }],
    ["form-unhooked", { agentId: "unhooked", refusals: 0 }],
  ]);
  const redeemed: { token: string; botToken: string }[] = [];
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
        return { admitted: true, userId: found.userId, role, timeZone: null };
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
      async relinkOwnerAccess(accessSub, tokenHash) {
        if (!ownerId) return { ok: false, reason: "no_owner" };
        if (spentTokens.has(tokenHash)) return { ok: false, reason: "token_spent" };
        spentTokens.add(tokenHash);
        relinks.push({ accessSub, tokenHash });
        for (const [entry, value] of identities) {
          if (entry.startsWith(`${ACCESS_SOURCE}:`) && value.userId === ownerId) {
            identities.delete(entry);
          }
        }
        identities.set(`${ACCESS_SOURCE}:${accessSub}`, { userId: ownerId, status: "enabled" });
        return { ok: true };
      },
    },
    commands: createConfigCommands(ports),
    forms: {
      async describeForm(token) {
        if (token === "form-down") return { ok: false, reason: "store_unavailable" };
        const form = forms.get(token);
        return form
          ? { ok: true, agentId: form.agentId, kind: "telegram" }
          : { ok: false, reason: "unknown_form" };
      },
      async redeemTelegramForm(token, botToken) {
        const form = forms.get(token);
        if (!form) return { ok: false, reason: "unknown_form" };
        redeemed.push({ token, botToken });
        if (botToken !== GOOD_BOT_TOKEN) {
          form.refusals += 1;
          if (form.refusals >= 2) forms.delete(token);
          return { ok: false, reason: botToken.includes(":") ? "token_refused" : "invalid_token" };
        }
        forms.delete(token);
        return {
          ok: true,
          agentId: form.agentId,
          bot: { id: 1, username: "kelpie_<b>bot" },
          webhook: form.agentId === "unhooked" ? "channel_refused" : "registered",
        };
      },
    },
    bootstrapToken: TOKEN,
    recoveryToken: undefined,
    now: () => NOW_MS,
    newUserId: () => "u-new",
  };
  return { deps, ran, bootstraps, redeemed, relinks };
}

function post(path: string, body?: unknown) {
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" } };
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

  it("lists the vault's held files, and forgets erased paths", async () => {
    const { deps } = world();
    expect(await call(deps, "/commands/listHeldFiles")).toEqual({
      status: 200,
      body: {
        ok: true,
        value: [{ path: "memory/people/ana.md", state: "proposed", attempts: 1, at: NOW_MS }],
      },
    });
    expect(await call(deps, "/commands/forgetVaultPaths", { paths: ["memory/a.md"] })).toEqual({
      status: 200,
      body: { ok: true, value: { forgotten: 1, stillInVault: [] } },
    });
    expect((await call(deps, "/commands/forgetVaultPaths", { paths: [] })).status).toBe(400);
  });

  it("turns Dream off, or back to dry runs", async () => {
    const { deps } = world();
    expect(await call(deps, "/commands/setDream", { mode: "off" })).toEqual({
      status: 200,
      body: { ok: true, value: { mode: "off" } },
    });
    expect((await call(deps, "/commands/setDream", { mode: "write" })).status).toBe(400);
  });

  it("sets the owner's time zone", async () => {
    const { deps } = world();
    expect(await call(deps, "/commands/setTimeZone", { timeZone: "America/Sao_Paulo" })).toEqual({
      status: 200,
      body: { ok: true, value: { timeZone: "America/Sao_Paulo" } },
    });
    expect((await call(deps, "/commands/setTimeZone", { timeZone: "+03:00" })).status).toBe(400);
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
      "an identity that isn't paired",
      "/commands/enableIdentity",
      { channel: "telegram", channelUserId: "pending" },
      409,
    ],
  ])("maps %s to its HTTP status", async (_label, path, body, status) => {
    const { deps } = world();
    expect((await call(deps, path, body)).status).toBe(status);
  });

  it.each([
    ["an unknown command", "POST", "/commands/dropTables"],
    ["the removed addIdentity command", "POST", "/commands/addIdentity"],
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
        headers: { "content-type": "application/json", "content-length": "10" },
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

describe("admin API cross-site requests", () => {
  const CREATE = JSON.stringify({ id: "sales", name: "Sales" });
  const send = (deps: AdminDeps, path: string, headers: Record<string, string>, body: BodyInit) =>
    handle(new Request(`https://admin.example${path}`, { method: "POST", headers, body }), deps);

  it.each([
    // What `<form enctype="text/plain">` sends for a field named `{"id":"sales","name":"Sales`
    // with the value `"}`: a JSON body under a type that needs no CORS preflight.
    ["a text/plain form", "text/plain", '{"id":"sales","name":"Sales="}\r\n'],
    ["text/plain naming JSON in a parameter", "text/plain;application/json", CREATE],
    ["a form-encoded body", "application/x-www-form-urlencoded", CREATE],
    ["a multipart body", "multipart/form-data; boundary=x", CREATE],
  ])("refuses a command sent as %s, before running it", async (_label, type, body) => {
    const { deps, ran } = world();
    const response = await send(deps, "/commands/createAgent", { "content-type": type }, body);
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, reason: "not_json" });
    expect(ran).toEqual([]);
  });

  it("refuses a command without a Content-Type, even one that takes no input", async () => {
    const { deps, ran } = world();
    const bytes = new TextEncoder().encode(CREATE);
    expect((await send(deps, "/commands/createAgent", {}, bytes)).status).toBe(415);
    const empty = new Request("https://admin.example/commands/listAgents", { method: "POST" });
    expect((await handle(empty, deps)).status).toBe(415);
    expect(ran).toEqual([]);
  });

  it.each([
    [
      "Sec-Fetch-Site: cross-site",
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    ],
    [
      "Sec-Fetch-Site: same-site",
      { "sec-fetch-site": "same-site", origin: "https://chat.example" },
    ],
    ["Sec-Fetch-Site: none", { "sec-fetch-site": "none" }],
    ["a foreign Origin without Sec-Fetch-Site", { origin: "https://evil.example" }],
    ["Origin: null without Sec-Fetch-Site", { origin: "null" }],
    [
      "a cross-site text/plain form, which fails both checks",
      { "sec-fetch-site": "cross-site", "content-type": "text/plain" },
    ],
  ])("refuses a JSON command with %s, before running it", async (_label, headers) => {
    const { deps, ran } = world();
    const response = await send(
      deps,
      "/commands/createAgent",
      { "content-type": "application/json", ...headers },
      CREATE,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, reason: "cross_origin" });
    expect(ran).toEqual([]);
  });

  it.each([
    [
      "from its own origin, with a charset",
      {
        "content-type": "application/json; charset=utf-8",
        "sec-fetch-site": "same-origin",
        origin: "https://admin.example",
      },
    ],
    [
      "from its own Origin, in a browser without Sec-Fetch-Site",
      { "content-type": "application/json", origin: "https://admin.example" },
    ],
    ["with the media type in capitals", { "content-type": "Application/JSON" }],
    [
      "from a client that sends neither Origin nor Sec-Fetch-Site",
      { "content-type": "application/json" },
    ],
  ])("runs a JSON command %s", async (_label, headers) => {
    const { deps, ran } = world();
    expect((await send(deps, "/commands/createAgent", headers, CREATE)).status).toBe(200);
    expect(ran).toEqual(["registry.add"]);
  });

  it("applies the same rules to the bootstrap and the recovery", async () => {
    const plain = { "content-type": "text/plain" };
    const foreign = { "content-type": "application/json", "sec-fetch-site": "cross-site" };

    const fresh = world({ owner: false });
    const bootstrap = JSON.stringify({ token: TOKEN });
    expect((await send(fresh.deps, "/bootstrap", plain, bootstrap)).status).toBe(415);
    expect((await send(fresh.deps, "/bootstrap", foreign, bootstrap)).status).toBe(403);
    expect(fresh.bootstraps).toEqual([]);

    const back = world({ authenticated: "sub-new" });
    back.deps.recoveryToken = RECOVERY;
    const recovery = JSON.stringify({ token: RECOVERY });
    expect((await send(back.deps, "/recover", plain, recovery)).status).toBe(415);
    expect((await send(back.deps, "/recover", foreign, recovery)).status).toBe(403);
    expect(back.relinks).toEqual([]);
  });

  it("still answers 401 first when the Access JWT doesn't verify", async () => {
    const { deps } = world({ authenticated: null });
    const response = await send(
      deps,
      "/commands/createAgent",
      { "content-type": "text/plain" },
      CREATE,
    );
    expect(response.status).toBe(401);
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

describe("admin API access recovery", () => {
  /** The owner, back with a new Access `sub`, and a recovery token set for the occasion. */
  function returning() {
    const setup = world({ authenticated: "sub-new" });
    setup.deps.recoveryToken = RECOVERY;
    return setup;
  }

  it("relinks the owner to their new Access login, which then runs commands", async () => {
    const { deps, relinks } = returning();
    expect(await call(deps, "/commands/listAgents")).toEqual({
      status: 403,
      body: { ok: false, reason: "forbidden" },
    });

    expect(await call(deps, "/recover", { token: RECOVERY })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect((await call(deps, "/commands/listAgents")).status).toBe(200);
    // The Directory gets the token's hash, never the token.
    expect(relinks).toEqual([
      { accessSub: "sub-new", tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(JSON.stringify(relinks)).not.toContain(RECOVERY);
  });

  it("takes a recovery token once", async () => {
    const { deps } = returning();
    await call(deps, "/recover", { token: RECOVERY });
    expect(await call(deps, "/recover", { token: RECOVERY })).toEqual({
      status: 410,
      body: { ok: false, reason: "recovery_token_spent" },
    });
  });

  it.each([
    ["a wrong token", { token: `${NOW_MS / 1_000 + 3_600}.${"decaf0".repeat(6)}` }],
    ["no token", {}],
    ["the bootstrap token", { token: TOKEN }],
  ])("refuses %s", async (_label, body) => {
    const { deps, relinks } = returning();
    expect(await call(deps, "/recover", body)).toEqual({
      status: 403,
      body: { ok: false, reason: "invalid_recovery_token" },
    });
    expect(relinks).toEqual([]);
  });

  it("refuses a recovery token that would live past a day, or that is the bootstrap token", async () => {
    const lasting = world({ authenticated: "sub-new" });
    lasting.deps.recoveryToken = `${NOW_MS / 1_000 + 25 * 3_600}.${"5eed".repeat(8)}`;
    expect(
      (await call(lasting.deps, "/recover", { token: lasting.deps.recoveryToken })).status,
    ).toBe(403);

    const shared = world({ authenticated: "sub-new" });
    shared.deps.recoveryToken = TOKEN;
    expect((await call(shared.deps, "/recover", { token: TOKEN })).status).toBe(403);
    expect([...lasting.relinks, ...shared.relinks]).toEqual([]);
  });

  it.each([
    ["identity_taken", 409],
    ["invalid_user", 400],
  ] as const)("answers the Directory's %s with %i", async (reason, status) => {
    const { deps } = returning();
    deps.directory.relinkOwnerAccess = async () => ({ ok: false, reason });
    expect(await call(deps, "/recover", { token: RECOVERY })).toEqual({
      status,
      body: { ok: false, reason },
    });
  });

  it("logs a refused recovery's reason, never the token or the login", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      logged.push(args);
    });
    const { deps } = returning();
    await call(deps, "/recover", { token: `${NOW_MS / 1_000 + 3_600}.${"decaf0".repeat(6)}` });
    expect(JSON.stringify(logged)).toContain("invalid_recovery_token");
    expect(JSON.stringify(logged)).not.toContain("decaf0");
    expect(JSON.stringify(logged)).not.toContain("sub-new");
    vi.restoreAllMocks();
  });

  it("refuses while no recovery token is set, or once it has expired", async () => {
    const unset = world({ authenticated: "sub-new" });
    expect((await call(unset.deps, "/recover", { token: RECOVERY })).status).toBe(403);

    const expired = returning();
    expired.deps.now = () => NOW_MS + 3_601_000;
    expect((await call(expired.deps, "/recover", { token: RECOVERY })).status).toBe(403);
    expect([...unset.relinks, ...expired.relinks]).toEqual([]);
  });

  it("sends a first run to the bootstrap, and needs a verified Access login", async () => {
    const fresh = world({ owner: false });
    fresh.deps.recoveryToken = RECOVERY;
    expect(await call(fresh.deps, "/recover", { token: RECOVERY })).toEqual({
      status: 403,
      body: { ok: false, reason: "no_owner" },
    });

    const stranger = world({ authenticated: null });
    stranger.deps.recoveryToken = RECOVERY;
    expect((await call(stranger.deps, "/recover", { token: RECOVERY })).status).toBe(401);
    expect(stranger.relinks).toEqual([]);
  });
});

describe("admin API secure forms", () => {
  const formUrl = "https://admin.example/forms/form-token-1";
  const submit = (botToken: string, headers: Record<string, string> = {}) =>
    new Request(formUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ botToken }).toString(),
    });

  it("starts with a command that returns the form's path", async () => {
    const { deps } = world();
    await call(deps, "/commands/createAgent", { id: "sales", name: "Sales" });
    expect(await call(deps, "/commands/connectTelegram", { agentId: "sales" })).toEqual({
      status: 200,
      body: { ok: true, value: { path: "/forms/form-token-1", expiresAt: NOW_MS + 900_000 } },
    });
  });

  it("shows the owner a password field, with headers that keep the page private", async () => {
    const { deps } = world();
    const response = await handle(new Request(formUrl), deps);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="botToken"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain("<code>sales</code>");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("stores the token, says which bot connected, and escapes what Telegram returned", async () => {
    const { deps, redeemed } = world();
    const response = await handle(
      submit(GOOD_BOT_TOKEN, { origin: "https://admin.example" }),
      deps,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("@kelpie_&lt;b&gt;bot");
    expect(html).toContain("now answers");
    expect(html).not.toContain(GOOD_BOT_TOKEN);
    expect(redeemed).toEqual([{ token: "form-token-1", botToken: GOOD_BOT_TOKEN }]);

    // The link works once.
    expect((await handle(new Request(formUrl), deps)).status).toBe(404);
  });

  it("says when the token is stored but Telegram couldn't be pointed at Kelpie", async () => {
    const { deps } = world();
    const response = await handle(
      new Request("https://admin.example/forms/form-unhooked", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://admin.example",
        },
        body: new URLSearchParams({ botToken: GOOD_BOT_TOKEN }).toString(),
      }),
      deps,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("now answers");
    expect(html).toContain("channel_refused");
    expect(html).toContain("registerTelegramWebhook");
    expect(html).toContain("do not reach Kelpie");
  });

  it("gives the owner a link that pairs their Telegram account", async () => {
    const { deps } = world();
    await call(deps, "/commands/createAgent", { id: "sales", name: "Sales" });
    expect(await call(deps, "/commands/pairTelegram", { agentId: "sales" })).toEqual({
      status: 200,
      body: {
        ok: true,
        value: { link: "https://t.me/kelpie_bot?start=ABCD2345", expiresAt: NOW_MS + 3_600_000 },
      },
    });
  });

  it("registers a bot's webhook again on command, and says why it couldn't", async () => {
    const { deps } = world();
    await call(deps, "/commands/createAgent", { id: "sales", name: "Sales" });
    await call(deps, "/commands/createAgent", { id: "unwired", name: "Unwired" });
    expect(await call(deps, "/commands/registerTelegramWebhook", { agentId: "sales" })).toEqual({
      status: 200,
      body: { ok: true, value: { agentId: "sales", registered: true } },
    });
    expect(await call(deps, "/commands/registerTelegramWebhook", { agentId: "unwired" })).toEqual({
      status: 409,
      body: { ok: false, reason: "not_connected" },
    });
  });

  it("asks again after a refused token, and closes when the form does", async () => {
    const { deps } = world();
    const first = await handle(submit("not-a-token"), deps);
    expect(first.status).toBe(400);
    const html = await first.text();
    expect(html).toContain("doesn&#39;t look like a bot token");
    expect(html).not.toContain("not-a-token");

    const second = await handle(submit("123:wrong"), deps);
    expect(second.status).toBe(404);
  });

  it("refuses a submission from another site, before it reaches the store", async () => {
    const { deps, redeemed } = world();
    const response = await handle(submit(GOOD_BOT_TOKEN, { origin: "https://evil.example" }), deps);
    expect(response.status).toBe(403);
    expect(redeemed).toEqual([]);
  });

  it("serves the form to the owner only", async () => {
    const stranger = world({ authenticated: null });
    expect((await handle(new Request(formUrl), stranger.deps)).status).toBe(401);
    const member = world({ role: "member" });
    expect((await handle(new Request(formUrl), member.deps)).status).toBe(403);
    expect((await handle(submit(GOOD_BOT_TOKEN), member.deps)).status).toBe(403);
    expect(member.redeemed).toEqual([]);
  });

  it("answers 404 to a malformed link or another method, and 413 to a huge body", async () => {
    const { deps, redeemed } = world();
    expect(
      (await handle(new Request("https://admin.example/forms/bad%20token"), deps)).status,
    ).toBe(404);
    expect((await handle(new Request(formUrl, { method: "PUT" }), deps)).status).toBe(404);
    const huge = new Request(formUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `botToken=${"x".repeat(70_000)}`,
    });
    expect((await handle(huge, deps)).status).toBe(413);
    expect(redeemed).toEqual([]);
  });

  it("accepts its own submission, which browsers may send with Origin: null", async () => {
    const { deps, redeemed } = world();
    const response = await handle(
      submit(GOOD_BOT_TOKEN, { origin: "null", "sec-fetch-site": "same-origin" }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(redeemed).toHaveLength(1);
  });

  it("refuses submissions the browser marks as coming from another site", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const { deps, redeemed } = world();
      const response = await handle(
        submit(GOOD_BOT_TOKEN, { origin: "https://admin.example", "sec-fetch-site": site }),
        deps,
      );
      expect(response.status).toBe(403);
      expect(redeemed).toEqual([]);
    }
  });

  it("takes only form-encoded submissions, and doesn't count an empty one", async () => {
    const { deps, redeemed } = world();
    const json = new Request(formUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botToken: GOOD_BOT_TOKEN }),
    });
    expect((await handle(json, deps)).status).toBe(415);

    const empty = await handle(submit("   "), deps);
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("Paste the bot token first.");
    expect(redeemed).toEqual([]);
  });

  it("shows a try-again page when Access keys or the secret store can't be reached", async () => {
    const down = world();
    down.deps.authenticate = async () => {
      throw new Error("Access keys returned 502");
    };
    expect((await handle(new Request(formUrl), down.deps)).status).toBe(503);

    const { deps } = world();
    expect((await handle(new Request("https://admin.example/forms/form-down"), deps)).status).toBe(
      503,
    );
  });

  it("escapes the agent id it shows", async () => {
    const { deps } = world();
    const html = await (
      await handle(new Request("https://admin.example/forms/form-odd"), deps)
    ).text();
    expect(html).toContain("<code>&lt;i&gt;odd&lt;/i&gt;</code>");
    expect(html).not.toContain("<i>odd</i>");
  });
});

describe("admin API pairing page", () => {
  const pageUrl = (agentId: string) => `https://admin.example/pair/telegram/${agentId}`;
  const press = (agentId: string, headers: Record<string, string> = {}) =>
    new Request(pageUrl(agentId), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: "",
    });
  const sameOrigin = { origin: "https://admin.example" };

  it("shows the owner a button, and pairs only when its own page posts", async () => {
    const { deps, ran } = world();
    await call(deps, "/commands/createAgent", { id: "sales", name: "<i>Sales</i>" });

    const shown = await handle(new Request(pageUrl("sales")), deps);
    expect(shown.status).toBe(200);
    const form = await shown.text();
    expect(form).toContain('<form method="post">');
    expect(form).toContain("&lt;i&gt;Sales&lt;/i&gt;");
    expect(form).toContain("<code>sales</code>");
    expect(form).not.toContain("t.me");
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(shown.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(ran).not.toContain("directory.issuePairingCode");

    const paired = await handle(press("sales", sameOrigin), deps);
    expect(paired.status).toBe(200);
    expect(await paired.text()).toContain('href="https://t.me/kelpie_bot?start=ABCD2345"');
    expect(ran.filter((step) => step === "directory.issuePairingCode")).toHaveLength(1);
  });

  it("serves the page to the owner only, and takes no post from another site", async () => {
    const stranger = world({ authenticated: null });
    expect((await handle(new Request(pageUrl("sales")), stranger.deps)).status).toBe(401);
    const member = world({ role: "member" });
    expect((await handle(press("sales", sameOrigin), member.deps)).status).toBe(403);

    const { deps, ran } = world();
    await call(deps, "/commands/createAgent", { id: "sales", name: "Sales" });
    expect((await handle(press("sales", { origin: "https://evil.example" }), deps)).status).toBe(
      403,
    );
    expect(
      (await handle(press("sales", { ...sameOrigin, "sec-fetch-site": "cross-site" }), deps))
        .status,
    ).toBe(403);
    const json = new Request(pageUrl("sales"), {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin },
      body: "{}",
    });
    expect((await handle(json, deps)).status).toBe(415);
    expect([...stranger.ran, ...member.ran, ...ran]).not.toContain("directory.issuePairingCode");
  });

  it("answers 404 for an unknown agent or a malformed id, and says when no bot is connected", async () => {
    const { deps, ran } = world();
    await call(deps, "/commands/createAgent", { id: "unwired", name: "Unwired" });
    expect((await handle(new Request(pageUrl("ghost")), deps)).status).toBe(404);
    expect((await handle(new Request(pageUrl("Bad%20Id")), deps)).status).toBe(404);
    expect((await handle(new Request(pageUrl("unwired"), { method: "PUT" }), deps)).status).toBe(
      404,
    );

    const unwired = await handle(press("unwired", sameOrigin), deps);
    expect(unwired.status).toBe(409);
    expect(await unwired.text()).toContain("Connect the agent's Telegram bot first");
    expect(ran).not.toContain("directory.issuePairingCode");
  });
});
