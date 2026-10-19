import { ACCESS_SOURCE } from "@kelpie/access";
import type { CommandResult, ConfigCommands, Proposal, ProposalDetail } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import { type AdminDeps, handle } from "../src/api.ts";

// The proposals' pages (ADR-0061, #302): the owner reads a proposal in full and approves or refuses
// it, behind Access and the owner check, and only the page's own submission decides. A GET changes
// nothing, and a repeat is never a 500.

const NOW = 1_791_000_000_000;
const ID = "1a2b3c4d-1111-4222-8333-444455556666";
const TASK = "0f8b7c1e-6a2d-4c3b-9e5f-1a2b3c4d5e6f";
const pageUrl = (path = `/proposals/${ID}`) => `https://admin.example${path}`;
const sameOrigin = { origin: "https://admin.example" };

const proposal = (fields: Partial<Proposal> = {}): Proposal => ({
  id: ID,
  proposer: "sales",
  target: "sales-sub-a1b2c3",
  actingUserId: "u-owner",
  taskId: TASK,
  changes: { remit: "Prices quotes.", tools: ["complete_task"] },
  before: { remit: "", tools: ["memory_search", "complete_task"] },
  reason: 'Quotes <script>alert("x")</script>\u200b need it.',
  status: "pending",
  createdAt: NOW - 3_600_000,
  expiresAt: NOW + 71 * 3_600_000,
  decidedAt: null,
  decidedBy: null,
  ...fields,
});

function world({
  role = "owner" as "owner" | "member",
  authenticated = true,
  detail = { ...proposal(), current: proposal().before, stale: false } as ProposalDetail | null,
  decided = { ok: true, value: proposal({ status: "applied" }) } as CommandResult<Proposal>,
  failRead = false,
} = {}) {
  const ran: string[] = [];
  const commands = {
    async listProposals(actor: { via: string }, input: unknown) {
      ran.push(`list ${JSON.stringify(input)} ${actor.via}`);
      if (failRead) return { ok: false, reason: "unavailable" };
      return { ok: true, value: detail ? [proposal()] : [] };
    },
    async getProposal(actor: { via: string }, input: { id: string }) {
      ran.push(`get ${input.id} ${actor.via}`);
      if (failRead) return { ok: false, reason: "unavailable" };
      return detail ? { ok: true, value: detail } : { ok: false, reason: "unknown_proposal" };
    },
    async decideProposal(actor: { via: string }, input: unknown) {
      ran.push(`decide ${JSON.stringify(input)} ${actor.via}`);
      return decided;
    },
  } as unknown as ConfigCommands;
  const deps = {
    authenticate: async () =>
      authenticated ? { ok: true, sub: "sub-owner" } : { ok: false, reason: "signature" },
    directory: {
      async admit(identity: { channel: string; channelUserId: string }) {
        return identity.channel === ACCESS_SOURCE && identity.channelUserId === "sub-owner"
          ? { admitted: true, userId: "u-owner", role, timeZone: null }
          : { admitted: false, reason: "unknown_identity" };
      },
    },
    commands,
    now: () => NOW,
  } as unknown as AdminDeps;
  return { deps, ran };
}

const submit = (decision: string | null, headers: Record<string, string> = sameOrigin) =>
  new Request(pageUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: decision === null ? "" : new URLSearchParams({ decision }).toString(),
  });

describe("a proposal's page (#302)", () => {
  it("shows the whole change, the agents by id, the task, the expiry, and Approve or Refuse", async () => {
    const { deps, ran } = world();

    const response = await handle(new Request(pageUrl()), deps);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain("<code>sales</code>");
    expect(html).toContain("<code>sales-sub-a1b2c3</code>");
    expect(html).toContain(`<code>${TASK}</code>`);
    expect(html).toContain("71 more hours");
    // Each field as it is now and as proposed.
    expect(html).toContain("Remit");
    expect(html).toContain("Prices quotes.");
    expect(html).toContain("&quot;memory_search&quot;");
    expect(html).toContain('<button type="submit" name="decision" value="approve"');
    expect(html).toContain('<button type="submit" name="decision" value="refuse"');
    expect(ran).toEqual([`get ${ID} admin-api`]);
  });

  it("shows the agent's reason escaped, its hidden characters written out, and labeled as its words", async () => {
    const html = await (await handle(new Request(pageUrl()), world().deps)).text();

    expect(html).toContain("In the agent&#39;s own words");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("\\u{200B}");
    expect(html).not.toContain("\u200b");
  });

  it("says a tools setting of null means every tool, as proposed or as it is now", async () => {
    const widening = world({
      detail: {
        ...proposal({ changes: { tools: null }, before: { tools: ["memory_search"] } }),
        current: { tools: ["memory_search"] },
        stale: false,
      },
    });
    const html = await (await handle(new Request(pageUrl()), widening.deps)).text();

    expect(html).toContain("Every tool it is given: no list limits it.");
    expect(html).not.toContain("<pre>null</pre>");
    // Narrowing an agent that holds every tool.
    const narrowing = world({
      detail: {
        ...proposal({ changes: { tools: ["memory_search"] }, before: { tools: null } }),
        current: { tools: null },
        stale: false,
      },
    });
    const now = await (await handle(new Request(pageUrl()), narrowing.deps)).text();
    expect(now).toContain("Every tool it is given: no list limits it.");
    expect(now).toContain("&quot;memory_search&quot;");
  });

  it("leaves only Refuse, saying why, for a target that changed since", async () => {
    const stale = world({
      detail: {
        ...proposal(),
        current: { remit: "Edited.", tools: ["complete_task"] },
        stale: true,
      },
    });
    const html = await (await handle(new Request(pageUrl()), stale.deps)).text();

    expect(html).toContain("changed since this proposal");
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="refuse"');
  });

  it("shows a decided or expired proposal without a form, and an unknown one as 404", async () => {
    for (const [status, words] of [
      ["applied", "was approved"],
      ["refused", "was refused"],
      ["expired", "expired"],
      ["conflict", "changed since"],
      ["void", "was deleted"],
      ["applying", "being applied"],
    ] as const) {
      const { deps } = world({ detail: { ...proposal({ status }), current: null, stale: true } });
      const html = await (await handle(new Request(pageUrl()), deps)).text();
      expect(html, status).toContain(words);
      expect(html, status).not.toContain("<form");
    }
    const gone = await handle(new Request(pageUrl()), world({ detail: null }).deps);
    expect(gone.status).toBe(404);
    const malformed = await handle(new Request(pageUrl("/proposals/nope")), world().deps);
    expect(malformed.status).toBe(404);
    const unreadable = await handle(new Request(pageUrl()), world({ failRead: true }).deps);
    expect(unreadable.status).toBe(503);
  });

  it("follows the link's language", async () => {
    const html = await (await handle(new Request(`${pageUrl()}?lang=pt-BR`), world().deps)).text();
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain("Aprovar");
    expect(html).toContain("Recusar");
    expect(html).toContain("Função");
  });
});

describe("deciding on a proposal's page (#302)", () => {
  it("approves or refuses only through its own submission, as the owner", async () => {
    const approve = world();
    const applied = await handle(submit("approve"), approve.deps);
    expect(applied.status).toBe(200);
    expect(await applied.text()).toContain("is applied");
    expect(approve.ran).toEqual([`decide {"id":"${ID}","decision":"approve"} admin-api`]);

    const refuse = world({ decided: { ok: true, value: proposal({ status: "refused" }) } });
    const refused = await handle(submit("refuse"), refuse.deps);
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("Nothing changed");
  });

  it("answers a conflict, an expiry, a repeat and an unknown proposal by their status, never 500", async () => {
    for (const [decided, status, words] of [
      [{ ok: true, value: proposal({ status: "conflict" }) }, 409, "changed since"],
      [{ ok: true, value: proposal({ status: "void" }) }, 409, "was deleted"],
      [{ ok: true, value: proposal({ status: "expired" }) }, 410, "expired"],
      [{ ok: false, reason: "not_pending" }, 409, "already decided"],
      [{ ok: false, reason: "unknown_proposal" }, 404, "No such proposal"],
      [{ ok: false, reason: "unavailable" }, 503, "didn't answer"],
      // Taken, but its result didn't come back: Kelpie settles it.
      [{ ok: true, value: proposal({ status: "applying" }) }, 202, "Approval taken"],
    ] as const) {
      const response = await handle(submit("approve"), world({ decided }).deps);
      expect(response.status, JSON.stringify(decided)).toBe(status);
      expect(await response.text(), JSON.stringify(decided)).toContain(words);
    }
  });

  it("takes no post from another site, nor one that isn't the page's form, nor a member's", async () => {
    const checks: [Request, ReturnType<typeof world>, number][] = [
      [submit("approve", { origin: "https://evil.example" }), world(), 403],
      [submit("approve", { ...sameOrigin, "sec-fetch-site": "cross-site" }), world(), 403],
      [submit("approve", {}), world(), 403],
      [
        new Request(pageUrl(), {
          method: "POST",
          headers: { "content-type": "application/json", ...sameOrigin },
          body: JSON.stringify({ decision: "approve" }),
        }),
        world(),
        415,
      ],
      [submit("maybe"), world(), 400],
      [submit(null), world(), 400],
      [submit("approve"), world({ role: "member" }), 403],
      [submit("approve"), world({ authenticated: false }), 401],
      [new Request(pageUrl(), { method: "PUT" }), world(), 404],
      [new Request(pageUrl("/proposals"), { method: "POST" }), world(), 404],
    ];
    for (const [request, made, status] of checks) {
      expect((await handle(request, made.deps)).status).toBe(status);
      expect(made.ran.filter((step) => step.startsWith("decide"))).toEqual([]);
    }
  });
});

describe("the proposals' JSON commands (#302)", () => {
  const command = (name: string, body: unknown) =>
    new Request(pageUrl(`/commands/${name}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("only read: no JSON command decides, claims, finishes or makes a proposal", async () => {
    const { deps, ran } = world();

    expect((await handle(command("listProposals", { status: "pending" }), deps)).status).toBe(200);
    const read = await handle(command("getProposal", { id: ID }), deps);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ ok: true, value: { id: ID, stale: false } });
    for (const name of [
      "decideProposal",
      "proposeAgentChange",
      "claimProposal",
      "finishProposal",
      "refuseProposal",
    ]) {
      expect(
        (await handle(command(name, { id: ID, decision: "approve" }), deps)).status,
        name,
      ).toBe(404);
    }
    expect(ran.filter((step) => step.startsWith("decide"))).toEqual([]);
  });
});

describe("the proposals list (#302)", () => {
  it("lists the pending proposals, each linking to its page in the same language", async () => {
    const { deps, ran } = world();
    const html = await (await handle(new Request(`${pageUrl("/proposals")}?lang=es`), deps)).text();

    expect(html).toContain(`href="/proposals/${ID}?lang=es"`);
    expect(html).toContain("<code>sales</code>");
    expect(ran).toEqual(['list {"status":"pending"} admin-api']);
  });

  it("says why it is empty, for the owner only", async () => {
    const empty = await (
      await handle(new Request(pageUrl("/proposals")), world({ detail: null }).deps)
    ).text();
    expect(empty).toContain("No proposal waits for you.");
    expect(
      (await handle(new Request(pageUrl("/proposals")), world({ role: "member" }).deps)).status,
    ).toBe(403);
  });
});

describe("the proposals' pages in each language (#302)", () => {
  const LOCALES = ["en", "pt-BR", "es"] as const;

  it("writes every state of a proposal, its list and each decision in the link's language", async () => {
    for (const lang of LOCALES) {
      const at = (path: string) => `${pageUrl(path)}?lang=${lang}`;
      for (const status of [
        "pending",
        "applying",
        "applied",
        "refused",
        "expired",
        "conflict",
        "void",
      ] as const) {
        for (const expiresAt of [NOW + 30 * 60_000, NOW + 71 * 3_600_000]) {
          const detail = { ...proposal({ status, expiresAt }), current: null, stale: true };
          const html = await (
            await handle(new Request(at(`/proposals/${ID}`)), world({ detail }).deps)
          ).text();
          expect(html, `${lang} ${status}`).toContain(`<html lang="${lang}">`);
          expect(html, `${lang} ${status}`).toContain("<code>sales</code>");
        }
      }
      const listed = await (await handle(new Request(at("/proposals")), world().deps)).text();
      expect(listed).toContain(`href="/proposals/${ID}?lang=${lang}"`);
      const empty = await handle(new Request(at("/proposals")), world({ detail: null }).deps);
      expect(empty.status).toBe(200);
      for (const decided of [
        { ok: true, value: proposal({ status: "applied" }) },
        { ok: true, value: proposal({ status: "refused" }) },
        { ok: true, value: proposal({ status: "expired" }) },
        { ok: true, value: proposal({ status: "conflict" }) },
        { ok: true, value: proposal({ status: "void" }) },
        { ok: true, value: proposal({ status: "pending" }) },
        { ok: true, value: proposal({ status: "applying" }) },
        { ok: false, reason: "not_pending" },
        { ok: false, reason: "unknown_proposal" },
        { ok: false, reason: "invalid_input" },
      ] as const) {
        const request = new Request(at(`/proposals/${ID}`), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...sameOrigin },
          body: "decision=approve",
        });
        const html = await (await handle(request, world({ decided }).deps)).text();
        expect(html, `${lang} ${JSON.stringify(decided)}`).toContain(`<html lang="${lang}">`);
      }
      const unknown = await handle(new Request(at("/proposals/nope")), world().deps);
      expect(await unknown.text()).toContain(`<html lang="${lang}">`);
      const choose = await handle(
        new Request(at(`/proposals/${ID}`), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...sameOrigin },
          body: "decision=later",
        }),
        world().deps,
      );
      expect(choose.status).toBe(400);
      const down = await handle(new Request(at("/proposals")), world({ failRead: true }).deps);
      expect(down.status).toBe(503);
    }
  });

  it("answers a page that fails as unavailable, never 500", async () => {
    const { deps } = world();
    (deps.commands as unknown as { getProposal: () => Promise<never> }).getProposal = () =>
      Promise.reject(new Error("down"));
    expect((await handle(new Request(pageUrl()), deps)).status).toBe(503);
  });
});
