import { env, exports } from "cloudflare:workers";
import { derivedMascot, KELPIE_MASCOT, type Mascot, REGISTRY_NAME } from "@kelpie/config";
import { describe, expect, it } from "vitest";

// What ingress reads for the webchat's list of agents (ADR-0052 §7): each agent's mascot, through
// an entrypoint that reads and does nothing else, so ingress never binds an AgentHost.

const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
const owned = { userId: "u-owner", role: "owner", via: "test" } as const;

describe("AgentLooks", () => {
  it("names each listed agent's mascot: the owner's pick, or its default by its role", async () => {
    await env.REGISTRY.getByName(REGISTRY_NAME).add("sales", "Sales", owner);
    const picked: Mascot = { ...KELPIE_MASCOT, shape: "star", head: { type: "none" } };
    expect(
      await env.AGENT_HOST.getByName("sales").configure({ mascot: picked }, owned),
    ).toMatchObject({ ok: true });

    expect(await exports.AgentLooks.mascots(["kelpie", "sales"])).toEqual({
      kelpie: KELPIE_MASCOT,
      sales: picked,
    });
    await env.AGENT_HOST.getByName("sales").configure({ mascot: null }, owned);
    expect(await exports.AgentLooks.mascots(["sales"])).toEqual({ sales: derivedMascot("sales") });
  });

  it("answers nothing for an id the Registry doesn't list, or one that isn't an id", async () => {
    expect(await exports.AgentLooks.mascots(["nobody", "../kelpie", "kelpie", "kelpie"])).toEqual({
      kelpie: KELPIE_MASCOT,
    });
    expect(await exports.AgentLooks.mascots("kelpie" as unknown as string[])).toEqual({});
  });
});
