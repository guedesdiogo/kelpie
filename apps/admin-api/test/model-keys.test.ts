import { ACCESS_SOURCE } from "@kelpie/access";
import type { ModelKey, ModelKeyCheck } from "@kelpie/channels";
import {
  type ConfigCommands,
  type ConfigPorts,
  createConfigCommands,
  type SetupEvent,
} from "@kelpie/config";
import { describe, expect, it, vi } from "vitest";
import { type AdminDeps, handle } from "../src/api.ts";

// A model key's one-time form (ADR-0068, #496): the owner pastes the key on this page; the admin
// API checks it with llm-gateway's `ProviderCheck` first, then `ChannelForms` stores a key its check
// let through, or counts a refused one against the form. The page never shows the key again.

const OWNER_SUB = "sub-owner";
const NOW_MS = 1_791_000_000_000;
const GOOD = `sk-ant-api03-${"g".repeat(80)}`;
const REFUSED = `sk-ant-api03-${"r".repeat(80)}`;
const DOWN = `sk-ant-api03-${"d".repeat(80)}`;
const UNCHECKED = `cfat_${"u".repeat(40)}`;

/** Each candidate's check, as llm-gateway would answer it. */
const CHECKS: Record<string, ModelKeyCheck> = {
  [GOOD]: "accepted",
  [REFUSED]: "refused",
  [DOWN]: "unreachable",
  [UNCHECKED]: "unchecked",
};

const notUsed = (): Promise<never> => Promise.reject(new Error("not used here"));

/** Forms as channel-egress holds them: open ones by token, and the ones used a moment ago. */
function world() {
  const open = new Map<string, { name: string; refusals: number }>([
    ["key-form", { name: "anthropic", refusals: 0 }],
    ["gateway-form", { name: "ai-gateway", refusals: 0 }],
    ["odd-form", { name: "<b>odd</b>", refusals: 0 }],
  ]);
  const used = new Map<string, { name: ModelKey; value: string }>();
  const checked: string[] = [];
  const stored: { name: string; value: string; check: string }[] = [];
  const reported: { agentId: string; event: SetupEvent }[] = [];
  const channels: ConfigPorts["channels"] = {
    createTelegramForm: notUsed,
    registerTelegramWebhook: notUsed,
    describeTelegramBot: notUsed,
    createRunnerForm: notUsed,
    describeRunner: notUsed,
    disconnectTelegram: notUsed,
    async createModelKeyForm(name) {
      return { ok: true, token: `form-${name}`, expiresAt: NOW_MS + 900_000 };
    },
    async removeModelKey() {
      return { ok: true, removed: true };
    },
  };
  const deps: AdminDeps = {
    async authenticate() {
      return { ok: true, sub: OWNER_SUB };
    },
    directory: {
      async admit(identity) {
        return identity.channel === ACCESS_SOURCE && identity.channelUserId === OWNER_SUB
          ? { admitted: true, userId: "u-owner", role: "owner", timeZone: null }
          : { admitted: false, reason: "unknown_identity" };
      },
      ownerExists: async () => true,
      bootstrapOwner: notUsed,
      relinkOwnerAccess: notUsed,
    },
    commands: createConfigCommands({ channels } as unknown as ConfigPorts),
    forms: {
      async describeForm(token) {
        const form = open.get(token);
        if (token === "down-form") return { ok: false, reason: "store_unavailable" };
        return form
          ? { ok: true, agentId: form.name, kind: "provider" }
          : { ok: false, reason: "unknown_form" };
      },
      redeemTelegramForm: notUsed,
      redeemRunnerForm: notUsed,
      async redeemModelKeyForm(token, value, check) {
        const done = used.get(token);
        // A form used a moment ago answers its own key again, as channel-egress does.
        if (done) {
          return done.value === value
            ? { ok: true, name: done.name, check }
            : { ok: false, reason: "unknown_form" };
        }
        const form = open.get(token);
        if (!form) return { ok: false, reason: "unknown_form" };
        if (value.length < 16 || /\s/.test(value)) {
          form.refusals += 1;
          if (form.refusals >= 5) open.delete(token);
          return { ok: false, reason: "invalid_key" };
        }
        open.delete(token);
        used.set(token, { name: form.name as ModelKey, value });
        stored.push({ name: form.name, value, check });
        return { ok: true, name: form.name as ModelKey, check };
      },
      async refuseModelKey(token) {
        const form = open.get(token);
        if (!form) return { ok: true, open: false };
        form.refusals += 1;
        if (form.refusals >= 5) open.delete(token);
        return { ok: true, open: open.has(token) };
      },
    },
    async checkModelKey(name, value) {
      checked.push(`${name} ${value}`);
      return CHECKS[value] ?? "refused";
    },
    async setupDone(agentId, event) {
      reported.push({ agentId, event });
    },
    master: async () => "kelpie",
    bootstrapToken: undefined,
    recoveryToken: undefined,
    now: () => NOW_MS,
    newUserId: () => "u-new",
  };
  return { deps, open, checked, stored, reported };
}

const submit = (token: string, modelKey: string, lang = "en") =>
  new Request(`https://admin.example/forms/${token}?lang=${lang}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
    },
    body: new URLSearchParams({ modelKey }).toString(),
  });

async function page(response: Response) {
  return { status: response.status, html: await response.text() };
}

describe("a model key's form page", () => {
  it("shows a password field for the key, naming which one, and nothing else", async () => {
    const { deps } = world();
    const { status, html } = await page(
      await handle(new Request("https://admin.example/forms/key-form?lang=pt-BR"), deps),
    );
    expect(status).toBe(200);
    expect(html).toContain('name="modelKey"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain("chave da API da Anthropic");
    expect(html).not.toContain('name="botToken"');
    expect(html).not.toContain('name="runnerSecret"');
  });

  it("shows a slot it doesn't know as a closed link", async () => {
    const { deps } = world();
    const { status, html } = await page(
      await handle(new Request("https://admin.example/forms/odd-form"), deps),
    );
    expect(status).toBe(404);
    expect(html).not.toContain("<b>odd</b>");
  });

  it("checks the key, stores it, reports it to Master, and never shows it again", async () => {
    const { deps, checked, stored, reported } = world();
    const { status, html } = await page(await handle(submit("key-form", `  ${GOOD}\n`), deps));
    expect(status).toBe(200);
    expect(html).toContain("is saved");
    expect(html).not.toContain(GOOD);
    expect(checked).toEqual([`anthropic ${GOOD}`]);
    expect(stored).toEqual([{ name: "anthropic", value: GOOD, check: "accepted" }]);
    expect(reported).toEqual([
      {
        agentId: "kelpie",
        event: {
          step: "model_key_connected",
          userId: "u-owner",
          provider: "anthropic",
          check: "accepted",
        },
      },
    ]);

    // A double click: the same key on the used link gets the same page, without another check.
    const again = await page(await handle(submit("key-form", GOOD), deps));
    expect(again.status).toBe(200);
    expect(again.html).toContain("is saved");
    expect(checked).toHaveLength(1);
    // Any other value on the used link finds it closed, and isn't sent anywhere.
    const other = await page(await handle(submit("key-form", REFUSED), deps));
    expect(other.status).toBe(404);
    expect(checked).toHaveLength(1);
  });

  it("stores a key its service can't check, and says so", async () => {
    const { deps, stored, reported } = world();
    const { status, html } = await page(await handle(submit("gateway-form", UNCHECKED), deps));
    expect(status).toBe(200);
    expect(html).toContain("couldn't check it");
    expect(html).not.toContain(UNCHECKED);
    expect(stored).toEqual([{ name: "ai-gateway", value: UNCHECKED, check: "unchecked" }]);
    expect(reported[0]?.event).toMatchObject({ provider: "ai-gateway", check: "unchecked" });
  });

  it("counts a refused key against the form, and closes it after five", async () => {
    const { deps, open, stored, reported } = world();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const { status, html } = await page(await handle(submit("key-form", REFUSED), deps));
      expect(status, String(attempt)).toBe(400);
      expect(html).toContain("accept that key");
      expect(html).not.toContain(REFUSED);
    }
    const last = await page(await handle(submit("key-form", REFUSED), deps));
    expect(last.status).toBe(404);
    expect(open.has("key-form")).toBe(false);
    expect(stored).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("counts a malformed key without checking it", async () => {
    const { deps, checked, open } = world();
    const { status, html } = await page(await handle(submit("key-form", "too short"), deps));
    expect(status).toBe(400);
    expect(html).toContain("look like a key");
    expect(checked).toEqual([]);
    expect(open.get("key-form")?.refusals).toBe(1);
  });

  it("leaves the form open, without counting, when the service can't answer or nothing was pasted", async () => {
    const { deps, open, stored } = world();
    const down = await page(await handle(submit("key-form", DOWN), deps));
    expect(down.status).toBe(502);
    expect(down.html).toContain("reach the service");
    const empty = await page(await handle(submit("key-form", "   "), deps));
    expect(empty.status).toBe(400);
    expect(open.get("key-form")?.refusals).toBe(0);
    expect(stored).toEqual([]);
  });

  it("checks nothing for a closed link, and answers an unreachable store as such", async () => {
    const { deps, checked } = world();
    expect((await handle(submit("gone-form", GOOD), deps)).status).toBe(404);
    expect((await handle(submit("down-form", GOOD), deps)).status).toBe(503);
    expect(checked).toEqual([]);
  });

  it("answers the owner's page even when the check fails, and logs neither the key nor the link", async () => {
    const logged: unknown[][] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged.push(args);
      });
    }
    const { deps } = world();
    deps.checkModelKey = async () => {
      throw new Error(`boom ${GOOD}`);
    };
    expect((await handle(submit("key-form", GOOD), deps)).status).toBe(503);
    expect(JSON.stringify(logged)).not.toContain(GOOD);
    expect(JSON.stringify(logged)).not.toContain("key-form");
    vi.restoreAllMocks();
  });
});

describe("the model keys' commands", () => {
  it("open a form and remove a key, for the owner", async () => {
    const { deps } = world();
    const run = async (name: keyof ConfigCommands, body: unknown) => {
      const response = await handle(
        new Request(`https://admin.example/commands/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        deps,
      );
      return { status: response.status, body: await response.json() };
    };
    expect(await run("connectModelKey", { provider: "openai" })).toEqual({
      status: 200,
      body: {
        ok: true,
        value: { provider: "openai", path: "/forms/form-openai", expiresAt: NOW_MS + 900_000 },
      },
    });
    expect(await run("removeModelKey", { provider: "openai" })).toEqual({
      status: 200,
      body: { ok: true, value: { provider: "openai", removed: true } },
    });
    expect((await run("removeModelKey", { provider: "gemini" })).status).toBe(400);
  });
});
