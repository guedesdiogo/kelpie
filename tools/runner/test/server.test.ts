import { describe, expect, it } from "vitest";
import { PROTOCOL, VERSION } from "../src/protocol.ts";
import { createHandler, type LogEntry } from "../src/server.ts";

const SECRET = "a".repeat(64);

function setup() {
  const logs: LogEntry[] = [];
  const handle = createHandler({ secrets: [SECRET], log: (entry) => logs.push(entry) });
  const call = (path: string, init: RequestInit = {}) =>
    handle(new Request(`http://runner${path}`, init));
  const auth = { authorization: `Bearer ${SECRET}` };
  return { logs, call, auth };
}

describe("the runner's handler", () => {
  it("answers /health with its version and protocol", async () => {
    const { call, auth } = setup();
    const response = await call("/health", { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: VERSION, protocol: PROTOCOL });
  });

  it("answers 401 without the secret, on any path, and says nothing more", async () => {
    const { call } = setup();
    for (const path of ["/health", "/anything"]) {
      const response = await call(path, { headers: { authorization: "Bearer wrong" } });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false });
    }
  });

  it("answers a URL that doesn't parse, as a malformed Host makes, with 401, or 400 once authorized", () => {
    const logs: LogEntry[] = [];
    const handle = createHandler({ secrets: [SECRET], log: (entry) => logs.push(entry) });
    const broken = (authorization: string) =>
      ({
        url: "http://a b/health",
        method: "GET",
        headers: new Headers({ authorization }),
      }) as unknown as Request;
    expect(handle(broken("Bearer guess")).status).toBe(401);
    expect(handle(broken(`Bearer ${SECRET}`)).status).toBe(400);
    expect(logs).toEqual([
      { method: "GET", path: "?", status: 401 },
      { method: "GET", path: "?", status: 400 },
    ]);
  });

  it("answers 404 for an unknown path once authorized", async () => {
    const { call, auth } = setup();
    expect((await call("/nope", { headers: auth })).status).toBe(404);
  });

  it("answers 405 for another method on /health", async () => {
    const { call, auth } = setup();
    const response = await call("/health", { method: "POST", headers: auth });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("logs each request's method, path and status, never its headers", async () => {
    const { call, logs, auth } = setup();
    await call("/health?x=1", { headers: auth });
    await call("/health", { headers: { authorization: "Bearer guess" } });
    expect(logs).toEqual([
      { method: "GET", path: "/health", status: 200 },
      { method: "GET", path: "/health", status: 401 },
    ]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});
