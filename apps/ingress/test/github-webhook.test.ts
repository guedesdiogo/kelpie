import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** The one signature the stub context-store in vitest.config.ts accepts. */
const ROUTED = `sha256=${"a".repeat(64)}`;

const post = (body: BodyInit, headers: Record<string, string>) =>
  exports.default.fetch("https://ingress.test/github/webhook", { method: "POST", headers, body });

describe("GitHub's webhook", () => {
  it("is handed to context-store with its event, signature and body", async () => {
    expect(
      (await post("{}", { "x-github-event": "push", "x-hub-signature-256": ROUTED })).status,
    ).toBe(202);
    const wrong = `sha256=${"b".repeat(64)}`;
    expect(
      (await post("{}", { "x-github-event": "push", "x-hub-signature-256": wrong })).status,
    ).toBe(401);
  });

  it("refuses a request without a well-formed signature before reading it", async () => {
    expect((await post("{}", { "x-github-event": "push" })).status).toBe(401);
    expect((await post("{}", { "x-hub-signature-256": "sha256=short" })).status).toBe(401);
  });

  it("refuses a body too large to be a vault push, chunked or not, and other methods", async () => {
    const large = await post("x".repeat(5_000_001), { "x-hub-signature-256": ROUTED });
    expect(large.status).toBe(413);
    // No Content-Length: the bytes are counted as they arrive.
    const chunk = new Uint8Array(1_000_000);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 6) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const chunked = await post(stream, { "x-hub-signature-256": ROUTED });
    expect(chunked.status).toBe(413);
    const get = await exports.default.fetch("https://ingress.test/github/webhook");
    expect(get.status).toBe(404);
  });
});
