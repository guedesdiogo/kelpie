import type { KeySet } from "../src/access-jwt.ts";

// Tokens shaped like Cloudflare Access's, signed with a key pair made in the test.

export const TEAM = "https://kelpie-test.cloudflareaccess.com";
export const AUD = "32eafc7626e974616deaf0dc3ce63d7bcbed58a2731e84d06bc3cdf1b53c4228";
export const NOW = 1_791_000_000;

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const json = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));

export async function signingKey(kid = "key-1") {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, publicKey: pair.publicKey, jwk: { ...jwk, kid } };
}

export type SigningKey = Awaited<ReturnType<typeof signingKey>>;

export function claims(overrides: Record<string, unknown> = {}) {
  return {
    aud: [AUD],
    email: "owner@example.com",
    exp: NOW + 60,
    iat: NOW,
    nbf: NOW,
    iss: TEAM,
    type: "app",
    identity_nonce: "6ei69kawdKzMIAPF",
    sub: "7335d417-61da-459d-899c-0a01c76a2f94",
    country: "BR",
    ...overrides,
  };
}

export async function sign(
  key: SigningKey,
  payload: Record<string, unknown> = claims(),
  header: Record<string, unknown> = { alg: "RS256", kid: key.kid, typ: "JWT" },
): Promise<string> {
  const unsigned = `${json(header)}.${json(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64Url(signature)}`;
}

export function keySet(...keys: SigningKey[]): KeySet {
  return { key: async (kid) => keys.find((key) => key.kid === kid)?.publicKey ?? null };
}
