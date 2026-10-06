import { describe, expect, it } from "vitest";
import { sanitizeSecrets } from "../src/index.ts";

// Secrets are assembled at run time, so no key-shaped literal sits in the repository for GitHub's
// push protection to flag.
const join = (...parts: string[]) => parts.join("");
const tail = (length: number, alphabet = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ") =>
  Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join("");

describe("sanitizeSecrets", () => {
  it.each([
    ["bearer_token", join("Authorization: ", "Bearer ", tail(24))],
    ["api_key", join("sk", "-", tail(32))],
    ["stripe_key", join("sk", "_live_", tail(24))],
    ["github_token", join("gh", "p_", tail(36))],
    ["github_token", join("github", "_pat_", tail(40))],
    ["aws_key", join("AK", "IA", tail(16, "ABCDEFGHIJKLMNOP0123456789"))],
    ["google_api_key", join("AI", "za", tail(35))],
    ["telegram_token", join("123456789", ":", "AA", tail(33))],
    ["slack_token", join("xo", "xb-", tail(30))],
    ["jwt", join("ey", "J", tail(20), ".", tail(30), ".", tail(30))],
    ["url_credentials", join("postgres://kelpie:", tail(12), "@db.example.com:5432/vault")],
    ["env_secret", join("OPENAI", "_API_KEY=", tail(20))],
    ["env_secret", join("MY_SERVICE", "_TOKEN=", tail(20))],
  ])("redacts a %s", (kind, secret) => {
    const { text, redactions } = sanitizeSecrets(`antes ${secret} depois`);
    expect(text).toContain(`[REDACTED:${kind}]`);
    expect(text).not.toContain(secret.slice(-12));
    expect(text.startsWith("antes ")).toBe(true);
    expect(redactions).toBeGreaterThan(0);
  });

  it("redacts a private key, terminated or cut off", () => {
    const body = tail(64);
    const whole = join(
      "-----BEGIN ",
      "PRIVATE KEY-----\n",
      body,
      "\n-----END ",
      "PRIVATE KEY-----",
    );
    expect(sanitizeSecrets(`a ${whole} b`).text).toBe("a [REDACTED:private_key] b");
    const cut = join("-----BEGIN ", "RSA PRIVATE KEY-----\n", body);
    expect(sanitizeSecrets(`a ${cut}`).text).toBe("a [REDACTED:private_key]");
  });

  it("leaves ordinary Portuguese, numbers and times alone", () => {
    const ordinary =
      "Reunião às 14:30, sala 12:00-13:00, ASIAPACIFICREGION, pit-stop-strategy, R$ 1.200,50, chave da casa com a Lúcia.";
    expect(sanitizeSecrets(ordinary)).toEqual({ text: ordinary, redactions: 0 });
  });

  it("strips terminal escapes, controls and bidirectional overrides before matching", () => {
    const split = join("gh", "p_", tail(18), "\u001b[31m", tail(18));
    const { text } = sanitizeSecrets(`x ${split} \u202eevil\u0007`);
    expect(text).toBe("x [REDACTED:github_token] evil");
  });

  it("is idempotent", () => {
    const once = sanitizeSecrets(
      join("OPENAI", "_API_KEY=", tail(20), " e ", "Bearer ", tail(24)),
    ).text;
    expect(sanitizeSecrets(once)).toEqual({ text: once, redactions: 0 });
  });

  it("stays fast on long text", () => {
    const started = Date.now();
    sanitizeSecrets(`${"password-token-key=".repeat(5_000)} ${"a".repeat(100_000)}`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
