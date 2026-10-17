import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { derivedMascot, KELPIE_MASCOT, type Mascot, REGISTRY_NAME } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import { AgentLooks } from "../src/agent-looks.ts";
import * as worker from "../src/index.ts";

// What ingress reads for the webchat's list of agents (ADR-0052 §7): each agent's mascot, through
// an entrypoint that reads and does nothing else, so ingress never binds an AgentHost.

const owner = { userId: "u-owner", role: "owner", via: "admin-api" } as const;
const owned = { userId: "u-owner", role: "owner", via: "test" } as const;

// The entrypoint is called in place, not through the Worker's own RPC: in a run of many files that
// loopback sometimes can't find its handler and hangs. Ingress's tests cover the binding.
const looks = new AgentLooks(createExecutionContext(), env);

describe("AgentLooks", () => {
  it("is an entrypoint of the Worker, which ingress's AGENT_LOOKS binding names", () => {
    expect(worker.AgentLooks).toBe(AgentLooks);
  });

  it("names each listed agent's mascot: the owner's pick, or its default by its role", async () => {
    await env.REGISTRY.getByName(REGISTRY_NAME).add("sales", "Sales", owner);
    const picked: Mascot = { ...KELPIE_MASCOT, shape: "star", head: { type: "none" } };
    expect(
      await env.AGENT_HOST.getByName("sales").configure({ mascot: picked }, owned),
    ).toMatchObject({ ok: true });

    expect(await looks.mascots(["kelpie", "sales"])).toEqual({
      kelpie: KELPIE_MASCOT,
      sales: picked,
    });
    await env.AGENT_HOST.getByName("sales").configure({ mascot: null }, owned);
    expect(await looks.mascots(["sales"])).toEqual({ sales: derivedMascot("sales") });
  });

  it("names how each listed agent shows: its mascot, its specialty and its remit (#379)", async () => {
    await env.REGISTRY.getByName(REGISTRY_NAME).add("looks-agenda", "Agenda", owner);
    const picked: Mascot = { ...KELPIE_MASCOT, shape: "bean", color: "fawn" };
    await env.AGENT_HOST.getByName("looks-agenda").configure(
      { mascot: picked, specialty: "Agenda e e-mail", remit: "Books meetings." },
      owned,
    );

    expect(await looks.looks(["kelpie", "looks-agenda", "nobody", "../kelpie"])).toEqual({
      kelpie: expect.objectContaining({ mascot: KELPIE_MASCOT, specialty: "" }),
      "looks-agenda": { mascot: picked, specialty: "Agenda e e-mail", remit: "Books meetings." },
    });
    expect(await looks.looks("kelpie" as unknown as string[])).toEqual({});
  });

  it("answers nothing for an id the Registry doesn't list, or one that isn't an id", async () => {
    expect(await looks.mascots(["nobody", "../kelpie", "kelpie", "kelpie"])).toEqual({
      kelpie: KELPIE_MASCOT,
    });
    expect(await looks.mascots("kelpie" as unknown as string[])).toEqual({});
  });
});
