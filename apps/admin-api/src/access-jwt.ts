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
  /** The last successful load; a failed one keeps the previous keys. */
  keys: Map<string, CryptoKey> | null;
  /** When the last load started, successful or not. */
  fetchedAt: number;
  loading: Promise<Map<string, CryptoKey>> | null;
}

/**
 * A new load waits this long after the previous one, successful or not, so made-up key ids or a
 * failing certs URL can't turn every request into a fetch.
 */
const REFETCH_INTERVAL_MS = 60_000;

/** Keys older than this are loaded again, so a key Access retired stops being trusted. */
const MAX_AGE_MS = 60 * 60_000;

/** Lives as long as the isolate, so most requests reuse the keys. */
const cache = new Map<string, CachedKeys>();

/**
 * Access's published keys, cached per isolate. An unknown key id or keys older than an hour trigger
 * a reload, at most once a minute; concurrent requests share one load.
 */
export function remoteKeySet(
  certsUrl: string,
  fetchKeys: (url: string) => Promise<Response> = (url) =>
    fetch(url, { signal: AbortSignal.timeout(5_000) }),
  now: () => number = Date.now,
): KeySet {
  return {
    async key(kid) {
      const entry = cache.get(certsUrl) ?? { keys: null, fetchedAt: -Infinity, loading: null };
      cache.set(certsUrl, entry);
      const age = now() - entry.fetchedAt;
      const known = entry.keys?.get(kid);
      if (known && age < MAX_AGE_MS) return known;
      if (!entry.loading && age >= REFETCH_INTERVAL_MS) {
        entry.fetchedAt = now();
        entry.loading = loadKeys(certsUrl, fetchKeys).finally(() => {
          entry.loading = null;
        });
      }
      if (!entry.loading) return known ?? null;
      const keys = await entry.loading;
      entry.keys = keys;
      return keys.get(kid) ?? null;
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
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // One unusable key doesn't take the others down.
    }
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
