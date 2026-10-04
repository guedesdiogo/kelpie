import { describe, expect, it } from "vitest";
import { importSecretsKey, open, seal } from "../src/secrets/crypto.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));

describe("secret store encryption", () => {
  it("opens what it sealed, in the same slot", async () => {
    const key = await importSecretsKey(KEY);
    const sealed = await seal(key, "telegram:sales", "123:secret");
    expect(sealed.ciphertext).not.toContain("123:secret");
    expect(await open(key, "telegram:sales", sealed)).toBe("123:secret");
  });

  it("uses a fresh IV every time", async () => {
    const key = await importSecretsKey(KEY);
    const first = await seal(key, "telegram:sales", "same");
    const second = await seal(key, "telegram:sales", "same");
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("refuses a value moved to another slot, tampered with, or sealed with another key", async () => {
    const key = await importSecretsKey(KEY);
    const sealed = await seal(key, "telegram:sales", "123:secret");
    expect(await open(key, "telegram:support", sealed)).toBeNull();

    const bytes = Uint8Array.from(atob(sealed.ciphertext), (c) => c.charCodeAt(0));
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = { ...sealed, ciphertext: btoa(String.fromCharCode(...bytes)) };
    expect(await open(key, "telegram:sales", tampered)).toBeNull();

    expect(await open(await importSecretsKey(OTHER_KEY), "telegram:sales", sealed)).toBeNull();
    expect(await open(key, "telegram:sales", { ...sealed, keyVersion: 2 })).toBeNull();
  });

  it("refuses a missing key, or one that isn't 32 bytes", async () => {
    for (const bad of [undefined, "", "not base64!", btoa("short")]) {
      await expect(importSecretsKey(bad)).rejects.toThrow("SECRETS_KEY");
    }
  });
});
