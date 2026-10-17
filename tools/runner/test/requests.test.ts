import { describe, expect, it } from "vitest";
import { readJson } from "../src/requests.ts";

// The request checks themselves are shared with channel-egress, and tested with them in
// packages/channels (#420).

describe("readJson", () => {
  const request = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request("http://runner/", { method: "POST", body, headers });

  it("reads a body within its bound", async () => {
    expect(await readJson(request('{"a":1}'), 7)).toEqual({ value: { a: 1 } });
  });

  it("refuses a body over its bound", async () => {
    expect(await readJson(request('{"a":12}'), 7)).toEqual({ status: 413 });
    expect(await readJson(request("{}", { "content-length": "8" }), 7)).toEqual({ status: 413 });
  });
});
