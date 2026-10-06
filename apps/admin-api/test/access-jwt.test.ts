import { clearKeyCacheForTesting, remoteKeySet, verifyAccessJwt } from "@kelpie/access";
import { afterEach, describe, expect, it } from "vitest";
import { AUD, claims, keySet, NOW, sign, signingKey, TEAM } from "./tokens.ts";

const config = { teamDomain: TEAM, audience: AUD };

afterEach(() => clearKeyCacheForTesting());

describe("verifyAccessJwt", () => {
  it("accepts a token Access signed for this application, and returns its sub", async () => {
    const key = await signingKey();
    expect(await verifyAccessJwt(await sign(key), config, keySet(key), NOW)).toEqual({
      ok: true,
      sub: "7335d417-61da-459d-899c-0a01c76a2f94",
    });
  });

  it("fails closed when the team domain or the audience isn't configured", async () => {
    const key = await signingKey();
    const token = await sign(key);
    for (const partial of [
      { ...config, teamDomain: "" },
      { ...config, audience: "" },
    ]) {
      expect(await verifyAccessJwt(token, partial, keySet(key), NOW)).toEqual({
        ok: false,
        reason: "not_configured",
      });
    }
  });

  it.each([
    ["no token", null, "missing"],
    ["two parts", "a.b", "malformed"],
    ["a header that isn't JSON", "bm90LWpzb24.e30.c2ln", "malformed"],
    ["characters outside base64url", "a+b.c.d", "malformed"],
  ])("refuses %s", async (_label, token, reason) => {
    const key = await signingKey();
    expect(await verifyAccessJwt(token, config, keySet(key), NOW)).toEqual({ ok: false, reason });
  });

  it("refuses any algorithm but RS256, whatever the token says", async () => {
    const key = await signingKey();
    for (const alg of ["none", "HS256", "RS512"]) {
      const token = await sign(key, claims(), { alg, kid: key.kid });
      expect(await verifyAccessJwt(token, config, keySet(key), NOW)).toEqual({
        ok: false,
        reason: "algorithm",
      });
    }
  });

  it("refuses a key it doesn't know, and a signature from another key", async () => {
    const key = await signingKey("key-1");
    const impostor = await signingKey("key-1");
    expect(await verifyAccessJwt(await sign(key), config, keySet(), NOW)).toEqual({
      ok: false,
      reason: "unknown_key",
    });
    expect(await verifyAccessJwt(await sign(impostor), config, keySet(key), NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("refuses a payload changed after signing", async () => {
    const key = await signingKey();
    const [header, , signature] = (await sign(key)).split(".");
    const forged = btoa(JSON.stringify(claims({ sub: "someone-else" })))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(
      await verifyAccessJwt(`${header}.${forged}.${signature}`, config, keySet(key), NOW),
    ).toEqual({ ok: false, reason: "signature" });
  });

  it.each([
    ["another issuer", { iss: "https://other.cloudflareaccess.com" }, "issuer"],
    ["another application", { aud: ["another-aud"] }, "audience"],
    ["an audience given as a plain string", { aud: AUD }, null],
    ["an expiry past the leeway", { exp: NOW - 61 }, "expired"],
    ["an expiry within the leeway", { exp: NOW - 59 }, null],
    ["no expiry", { exp: undefined }, "expired"],
    ["a start beyond the leeway", { nbf: NOW + 61 }, "not_yet_valid"],
    ["a service token", { sub: "", common_name: "ci.access" }, "not_a_person"],
    ["a token without sub", { sub: undefined }, "not_a_person"],
  ])("checks the claims: %s", async (_label, overrides, reason) => {
    const key = await signingKey();
    const token = await sign(key, claims(overrides));
    const result = await verifyAccessJwt(token, config, keySet(key), NOW);
    expect(result).toEqual(reason ? { ok: false, reason } : expect.objectContaining({ ok: true }));
  });
});

describe("remoteKeySet", () => {
  const CERTS = `${TEAM}/cdn-cgi/access/certs`;

  it("loads Access's published keys and caches them", async () => {
    const key = await signingKey();
    const urls: string[] = [];
    const keys = remoteKeySet(CERTS, async (url) => {
      urls.push(url);
      return Response.json({ keys: [key.jwk], public_cert: {}, public_certs: [] });
    });

    expect(await verifyAccessJwt(await sign(key), config, keys, NOW)).toMatchObject({ ok: true });
    expect(await verifyAccessJwt(await sign(key), config, keys, NOW)).toMatchObject({ ok: true });
    expect(urls).toEqual([CERTS]);
  });

  it("refetches for an unknown key id at most once a minute", async () => {
    const old = await signingKey("old");
    const rotated = await signingKey("rotated");
    let published = [old.jwk];
    let fetches = 0;
    let clock = 0;
    const keys = remoteKeySet(
      CERTS,
      async () => {
        fetches += 1;
        return Response.json({ keys: published });
      },
      () => clock,
    );

    expect(await keys.key("old")).not.toBeNull();
    // A made-up id within the minute doesn't trigger another fetch.
    expect(await keys.key("made-up")).toBeNull();
    expect(fetches).toBe(1);

    // After a minute, a new id refetches and finds the rotated key.
    published = [old.jwk, rotated.jwk];
    clock = 60_000;
    expect(await keys.key("rotated")).not.toBeNull();
    expect(fetches).toBe(2);
  });

  it("throws when Access's keys can't be loaded, so the API answers 503", async () => {
    const keys = remoteKeySet(CERTS, async () => new Response("down", { status: 502 }));
    await expect(keys.key("any")).rejects.toThrow("Access keys returned 502");
  });

  it("waits a minute after a failed load too, and shares one load between requests", async () => {
    let fetches = 0;
    const clock = 0;
    const keys = remoteKeySet(
      CERTS,
      async () => {
        fetches += 1;
        return new Response("down", { status: 502 });
      },
      () => clock,
    );

    const concurrent = await Promise.allSettled([keys.key("a"), keys.key("b"), keys.key("c")]);
    expect(concurrent.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(fetches).toBe(1);
    // Within the minute, a failing certs URL isn't asked again.
    expect(await keys.key("d")).toBeNull();
    expect(fetches).toBe(1);
  });

  it("skips a key it can't use instead of dropping the whole set", async () => {
    const good = await signingKey("good");
    const keys = remoteKeySet(CERTS, async () =>
      Response.json({
        keys: [
          { kty: "RSA", kid: "broken", n: "!!", e: "AQAB" },
          { ...good.jwk, kid: "other-alg", alg: "RS512" },
          good.jwk,
        ],
      }),
    );
    expect(await keys.key("good")).not.toBeNull();
    expect(await keys.key("broken")).toBeNull();
    expect(await keys.key("other-alg")).toBeNull();
  });

  it("loads the keys again after an hour, so a retired key stops being trusted", async () => {
    const key = await signingKey("k");
    let published: JsonWebKey[] = [key.jwk];
    let clock = 0;
    const keys = remoteKeySet(
      CERTS,
      async () => Response.json({ keys: published }),
      () => clock,
    );
    expect(await keys.key("k")).not.toBeNull();

    published = [];
    clock = 60 * 60_000;
    expect(await keys.key("k")).toBeNull();
  });
});
