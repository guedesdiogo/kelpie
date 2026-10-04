// Verifies the JWT Cloudflare Access adds to every request it lets through, in the
// `Cf-Access-Jwt-Assertion` header. Access signs it with RS256 and publishes the keys at
// `<team domain>/cdn-cgi/access/certs`.

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com`, the token's issuer. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
}

/** Where verification keys come from, by key id. */
export interface KeySet {
  key(kid: string): Promise<CryptoKey | null>;
}

export type Verification =
  | { ok: true; sub: string }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "missing"
        | "malformed"
        | "algorithm"
        | "unknown_key"
        | "signature"
        | "issuer"
        | "audience"
        | "expired"
        | "not_yet_valid"
        | "not_a_person";
    };

/** Clock drift allowed between Access and this Worker. */
const LEEWAY_SECONDS = 60;

/**
 * Checks the token's algorithm, signature, issuer, audience and validity window, and that it was
 * issued to a person: a service token has no `sub`. Anything else fails closed.
 */
export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  keys: KeySet,
  nowSeconds: number,
): Promise<Verification> {
  if (!config.teamDomain || !config.audience) return { ok: false, reason: "not_configured" };
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = parts;
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (!header || !payload || !signature) return { ok: false, reason: "malformed" };
  // The algorithm is fixed here, never taken from the token.
  if (header.alg !== "RS256") return { ok: false, reason: "algorithm" };
  if (typeof header.kid !== "string") return { ok: false, reason: "malformed" };

  const key = await keys.key(header.kid);
  if (!key) return { ok: false, reason: "unknown_key" };
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!valid) return { ok: false, reason: "signature" };

  if (payload.iss !== config.teamDomain) return { ok: false, reason: "issuer" };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) return { ok: false, reason: "audience" };
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_SECONDS < nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_SECONDS > nowSeconds) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (typeof payload.sub !== "string" || payload.sub === "" || "common_name" in payload) {
    return { ok: false, reason: "not_a_person" };
  }
  return { ok: true, sub: payload.sub };
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/** Refetching on an unknown key id waits this long, so made-up ids can't flood the certs URL. */
const REFETCH_INTERVAL_MS = 60_000;

/** Lives as long as the isolate, so most requests reuse the keys. */
const cache = new Map<string, CachedKeys>();

/** Access's published keys, cached per isolate and refetched when a new key id shows up. */
export function remoteKeySet(
  certsUrl: string,
  fetchKeys: (url: string) => Promise<Response> = fetch,
  now: () => number = Date.now,
): KeySet {
  return {
    async key(kid) {
      const cached = cache.get(certsUrl);
      const known = cached?.keys.get(kid);
      if (known) return known;
      if (cached && now() - cached.fetchedAt < REFETCH_INTERVAL_MS) return null;
      const fresh = await loadKeys(certsUrl, fetchKeys);
      cache.set(certsUrl, { keys: fresh, fetchedAt: now() });
      return fresh.get(kid) ?? null;
    },
  };
}

/** For tests: forget every cached key set. */
export function clearKeyCacheForTesting(): void {
  cache.clear();
}

async function loadKeys(
  certsUrl: string,
  fetchKeys: (url: string) => Promise<Response>,
): Promise<Map<string, CryptoKey>> {
  const response = await fetchKeys(certsUrl);
  if (!response.ok) throw new Error(`Access keys returned ${response.status}`);
  const body = (await response.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  return keys;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function decodeJson(value: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(value);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
