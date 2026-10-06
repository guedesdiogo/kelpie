import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const post = (body: string, headers: Record<string, string>) =>
  exports.default.fetch("https://ingress.test/github/webhook", { method: "POST", headers, body });

describe("GitHub's webhook", () => {
  it("is handed to context-store with its event, signature and body", async () => {
    const accepted = await post("{}", {
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=routed",
    });
    expect(accepted.status).toBe(202);
    const refused = await post("{}", {
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=wrong",
    });
    expect(refused.status).toBe(401);
  });

  it("refuses a body too large to be a vault push, and other methods", async () => {
    const large = await post("x".repeat(5_000_001), { "x-github-event": "push" });
    expect(large.status).toBe(413);
    const get = await exports.default.fetch("https://ingress.test/github/webhook");
    expect(get.status).toBe(404);
  });
});
