import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelForms, ProviderKeys, SetupForms } from "../src/index.ts";

// Model keys through a one-time form that expires (ADR-0068, #496): each in its slot of the secret
// store, `provider:<name>`, which only llm-gateway reads, through `ProviderKeys`. The admin API
// checks a key with llm-gateway's `ProviderCheck` before it gets here, so this Worker calls no
// provider: it stores what the check let through, and counts what it refused.

const ANTHROPIC = `sk-ant-api03-${"a".repeat(80)}`;
const OPENAI = `sk-proj-${"o".repeat(120)}`;
const ROTATED = `sk-ant-api03-${"r".repeat(80)}`;
const store = () => env.SECRET_STORE.getByName("secrets");

/** Opens a form for `name`'s slot. */
async function keyForm(name: string) {
  const form = await exports.ChannelForms.createModelKeyForm(name);
  if (!form.ok) throw new Error(`form refused: ${form.reason}`);
  return form.token;
}

/** Stores `value` in `name`'s slot through a form, as a key its check accepted. */
async function storeKey(name: string, value: string) {
  const stored = await exports.ChannelForms.redeemModelKeyForm(
    await keyForm(name),
    value,
    "accepted",
  );
  if (!stored.ok) throw new Error(`not stored: ${stored.reason}`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const name of ["anthropic", "openai", "ai-gateway", "typesafe"]) {
    await exports.ChannelForms.removeModelKey(name);
  }
});

describe("a model key's form", () => {
  it("opens for a known slot only, from the admin API's and the configuration tools' entrypoints", async () => {
    for (const forms of [exports.ChannelForms, exports.SetupForms]) {
      const form = await forms.createModelKeyForm("openai");
      if (!form.ok) throw new Error("form refused");
      expect(await exports.ChannelForms.describeForm(form.token)).toEqual({
        ok: true,
        agentId: "openai",
        kind: "provider",
      });
      for (const name of ["claude-code", "Anthropic", "provider:openai", "", 7]) {
        expect(await forms.createModelKeyForm(name as string), String(name)).toEqual({
          ok: false,
          reason: "invalid_input",
        });
      }
    }
    // The configuration tools' Worker opens the form and removes a key; it never redeems one.
    expect(Object.getOwnPropertyNames(SetupForms.prototype)).not.toContain("redeemModelKeyForm");
  });

  it("stores the key once, answers a double click the same, and never returns the key", async () => {
    const token = await keyForm("anthropic");
    const first = await exports.ChannelForms.redeemModelKeyForm(
      token,
      `  ${ANTHROPIC}\n`,
      "accepted",
    );
    expect(first).toEqual({ ok: true, name: "anthropic", check: "accepted" });
    expect(await exports.ChannelForms.redeemModelKeyForm(token, ANTHROPIC, "accepted")).toEqual(
      first,
    );
    // Any other value on the used link is refused, and stores nothing.
    expect(await exports.ChannelForms.redeemModelKeyForm(token, ROTATED, "accepted")).toEqual({
      ok: false,
      reason: "unknown_form",
    });
    expect(await exports.ChannelForms.describeForm(token)).toEqual({
      ok: false,
      reason: "unknown_form",
    });
    expect(await exports.ProviderKeys.keys()).toEqual({ ok: true, keys: { anthropic: ANTHROPIC } });
  });

  it("stores a key whose service has no read to check it with, and says so", async () => {
    const token = await keyForm("typesafe");
    expect(await exports.ChannelForms.redeemModelKeyForm(token, ANTHROPIC, "unchecked")).toEqual({
      ok: true,
      name: "typesafe",
      check: "unchecked",
    });
  });

  it("replaces a stored key with a new form's, and ends what the old form answers for", async () => {
    const old = await keyForm("anthropic");
    await exports.ChannelForms.redeemModelKeyForm(old, ANTHROPIC, "accepted");
    await storeKey("anthropic", ROTATED);
    expect(await exports.ProviderKeys.keys()).toEqual({ ok: true, keys: { anthropic: ROTATED } });
    expect(await exports.ChannelForms.redeemModelKeyForm(old, ANTHROPIC, "accepted")).toEqual({
      ok: false,
      reason: "unknown_form",
    });
  });

  it("counts a malformed key and each key its service refused, and closes after five", async () => {
    const token = await keyForm("openai");
    for (const malformed of ["short", `${OPENAI} trailing`, "x".repeat(513)]) {
      expect(await exports.ChannelForms.redeemModelKeyForm(token, malformed, "accepted")).toEqual({
        ok: false,
        reason: "invalid_key",
      });
    }
    expect(await exports.ChannelForms.refuseModelKey(token)).toEqual({ ok: true, open: true });
    expect(await exports.ChannelForms.refuseModelKey(token)).toEqual({ ok: true, open: false });
    // Five refusals: the link no longer works, even with a good key.
    expect(await exports.ChannelForms.redeemModelKeyForm(token, OPENAI, "accepted")).toEqual({
      ok: false,
      reason: "unknown_form",
    });
    expect(await exports.ChannelForms.refuseModelKey(token)).toEqual({ ok: true, open: false });
    expect(await exports.ProviderKeys.keys()).toEqual({ ok: true, keys: {} });
  });

  it("refuses a form past its lifetime, a check that didn't let the key through, and a form of another kind", async () => {
    const late = await keyForm("anthropic");
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec("UPDATE forms SET expires_at = 0");
    });
    expect(await exports.ChannelForms.redeemModelKeyForm(late, ANTHROPIC, "accepted")).toEqual({
      ok: false,
      reason: "unknown_form",
    });

    const token = await keyForm("anthropic");
    for (const check of ["refused", "unreachable", "yes"]) {
      expect(
        await exports.ChannelForms.redeemModelKeyForm(token, ANTHROPIC, check as "accepted"),
        check,
      ).toEqual({ ok: false, reason: "unknown_form" });
    }

    const telegram = await exports.ChannelForms.createTelegramForm("sales");
    if (!telegram.ok) throw new Error("form refused");
    expect(
      await exports.ChannelForms.redeemModelKeyForm(telegram.token, ANTHROPIC, "accepted"),
    ).toEqual({ ok: false, reason: "unknown_form" });
    expect(await exports.ChannelForms.refuseModelKey(telegram.token)).toEqual({
      ok: true,
      open: false,
    });
    expect(
      await exports.ChannelForms.redeemTelegramForm(
        token,
        "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw-test",
      ),
    ).toEqual({ ok: false, reason: "unknown_form" });
    expect(await exports.ChannelForms.redeemRunnerForm(token, "r".repeat(64))).toEqual({
      ok: false,
      reason: "unknown_form",
    });
    expect(await exports.ProviderKeys.keys()).toEqual({ ok: true, keys: {} });
  });

  it("stores the key encrypted, and neither the key nor the link's token in the clear", async () => {
    const token = await keyForm("openai");
    await exports.ChannelForms.redeemModelKeyForm(token, OPENAI, "accepted");
    const rows = await runInDurableObject(store(), (_instance, state) => ({
      secrets: state.storage.sql.exec("SELECT * FROM secrets").toArray(),
      forms: state.storage.sql.exec("SELECT * FROM forms").toArray(),
    }));
    expect(JSON.stringify(rows)).toContain("provider:openai");
    expect(JSON.stringify(rows)).not.toContain(OPENAI);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("logs no key or link token when the store fails", async () => {
    const logged: unknown[][] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged.push(args);
      });
    }
    const token = await keyForm("openai");
    const forms = new ChannelForms(createExecutionContext(), brokenStore());
    expect(await forms.redeemModelKeyForm(token, OPENAI, "accepted")).toEqual({
      ok: false,
      reason: "store_unavailable",
    });
    expect(await forms.refuseModelKey(token)).toEqual({ ok: false, reason: "store_unavailable" });
    expect(await forms.createModelKeyForm("openai")).toEqual({
      ok: false,
      reason: "store_unavailable",
    });
    expect(await forms.removeModelKey("openai")).toEqual({
      ok: false,
      reason: "store_unavailable",
    });
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(OPENAI);
    expect(JSON.stringify(logged)).not.toContain(token);
  });
});

describe("ProviderKeys", () => {
  it("returns the stored model keys only, never another slot's secret", async () => {
    expect(await exports.ProviderKeys.keys()).toEqual({ ok: true, keys: {} });
    await storeKey("anthropic", ANTHROPIC);
    await storeKey("ai-gateway", OPENAI);
    // Other kinds of secret sit in the same store.
    const bot = await store().createForm("sales", "telegram");
    await store().redeemForm(bot.token, JSON.stringify({ botToken: "123:abc" }));
    const runner = await store().createForm("vps", "runner");
    await store().redeemForm(runner.token, JSON.stringify({ secret: "r".repeat(64) }));
    expect(await exports.ProviderKeys.keys()).toEqual({
      ok: true,
      keys: { anthropic: ANTHROPIC, "ai-gateway": OPENAI },
    });
    // The entrypoint llm-gateway binds does nothing else.
    expect(
      Object.getOwnPropertyNames(ProviderKeys.prototype).filter((name) => name !== "constructor"),
    ).toEqual(["keys"]);
  });

  it("leaves out a slot whose value doesn't decrypt or isn't a key", async () => {
    await storeKey("anthropic", ANTHROPIC);
    await storeKey("openai", OPENAI);
    const typesafe = await store().createForm("typesafe", "provider");
    await store().redeemForm(typesafe.token, "not json");
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE secrets SET ciphertext = 'AAAA' || substr(ciphertext, 5) WHERE slot = 'provider:openai'",
      );
    });
    expect(await exports.ProviderKeys.keys()).toEqual({ ok: true, keys: { anthropic: ANTHROPIC } });
  });

  it("says when the store can't answer, so llm-gateway falls back", async () => {
    const keys = new ProviderKeys(createExecutionContext(), brokenStore());
    expect(await keys.keys()).toEqual({ ok: false, reason: "store_unavailable" });
    const closed = new ProviderKeys(createExecutionContext(), {
      ...env,
      SECRET_STORE: {
        getByName: () => ({ read: async () => ({ ok: false, reason: "store_unavailable" }) }),
      },
    } as unknown as Env);
    expect(await closed.keys()).toEqual({ ok: false, reason: "store_unavailable" });
  });
});

describe("removing a model key", () => {
  it("removes the key and every form for its slot, and leaves the other slots", async () => {
    await storeKey("anthropic", ANTHROPIC);
    await storeKey("openai", OPENAI);
    const open = await keyForm("anthropic");
    expect(await exports.SetupForms.removeModelKey("anthropic")).toEqual({
      ok: true,
      removed: true,
    });
    expect(await exports.ProviderKeys.keys()).toEqual({ ok: true, keys: { openai: OPENAI } });
    // A form opened before the removal can't store the key again.
    expect(await exports.ChannelForms.redeemModelKeyForm(open, ANTHROPIC, "accepted")).toEqual({
      ok: false,
      reason: "unknown_form",
    });
    expect(await exports.SetupForms.removeModelKey("anthropic")).toEqual({
      ok: true,
      removed: false,
    });
    expect(await exports.SetupForms.removeModelKey("telegram")).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });
});

/** An env whose secret store throws on every call, as one that can't be reached. */
function brokenStore(): Env {
  const failing = new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error(`unreachable ${OPENAI}`);
      },
    },
  );
  return { ...env, SECRET_STORE: { getByName: () => failing } } as unknown as Env;
}
