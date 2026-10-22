import { describe, expect, it } from "vitest";
import { isModelKey, isModelKeyValue, MODEL_KEYS, storedModelKeysOf } from "../src/model-keys.ts";

// The model keys the owner sets through a one-time form (ADR-0068): each in its slot of the secret
// store, `provider:<name>`, read by llm-gateway alone.

const KEY = `sk-ant-${"a".repeat(40)}`;

describe("model keys", () => {
  it("are the providers' keys, AI Gateway's token and Jev's key on TypeSafe", () => {
    expect(MODEL_KEYS).toEqual(["anthropic", "openai", "ai-gateway", "typesafe"]);
    for (const name of MODEL_KEYS) expect(isModelKey(name), name).toBe(true);
    for (const name of ["claude-code", "Anthropic", "provider:openai", "", null, 1]) {
      expect(isModelKey(name), String(name)).toBe(false);
    }
  });

  it("take a value of printable characters without spaces, 16 to 512 of them", () => {
    expect(isModelKeyValue(KEY)).toBe(true);
    expect(isModelKeyValue("x".repeat(16))).toBe(true);
    expect(isModelKeyValue("x".repeat(512))).toBe(true);
    for (const value of [
      "x".repeat(15),
      "x".repeat(513),
      `${KEY} `,
      `sk-ant-${"a".repeat(20)}\nsecond line`,
      `sk-ant-${"á".repeat(20)}`,
      12_345_678_901_234,
      null,
    ]) {
      expect(isModelKeyValue(value), String(value)).toBe(false);
    }
  });
});

describe("storedModelKeysOf", () => {
  it("keeps only known slots whose value is a key", () => {
    expect(
      storedModelKeysOf({
        ok: true,
        keys: { anthropic: KEY, openai: "short", "ai-gateway": 42, gemini: KEY },
      }),
    ).toEqual({ anthropic: KEY });
    expect(storedModelKeysOf({ ok: true, keys: {} })).toEqual({});
  });

  it("reads anything else as no answer, so the caller falls back", () => {
    for (const answer of [
      { ok: false, reason: "store_unavailable" },
      { ok: true },
      { ok: true, keys: null },
      { ok: true, keys: [KEY] },
      null,
      "keys",
    ]) {
      expect(storedModelKeysOf(answer), JSON.stringify(answer)).toBeNull();
    }
  });
});
