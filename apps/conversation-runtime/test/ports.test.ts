import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { portsFor, replacePortsForTesting } from "../src/ports.ts";

afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("production ports", () => {
  it("ask llm-gateway for the qualifier the agent chose", async () => {
    replacePortsForTesting(undefined);
    const qualify = vi.fn(async () => ({
      ok: true,
      result: { answers: {}, provider: "clef-workers-ai", calibrated: true },
    }));
    const ports = portsFor({ ...env, LLM_GATEWAY: { qualify } } as unknown as Env);

    await ports.qualifierFor("jev")?.qualify({ fragments: ["oi"] }, {});
    await ports.qualifierFor("clef")?.qualify({ fragments: ["oi"] }, {});
    expect(qualify.mock.calls.map((call: unknown[]) => call[2])).toEqual(["jev", "clef"]);
  });
});
