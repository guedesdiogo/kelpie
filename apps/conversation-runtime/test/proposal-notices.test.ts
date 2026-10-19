import type { ProposalNotice } from "@kelpie/config";
import { describe, expect, it } from "vitest";
import { proposalBubble, proposalNote } from "../src/proposal-notices.ts";

// Kelpie's notice of a proposal (ADR-0061, #302): the owner's bubble with the page's link, in the
// conversation's language, and the note for Master's model, which never holds the link.

const ID = "1a2b3c4d-1111-4222-8333-444455556666";
const NOW = Date.UTC(2026, 9, 18, 12);
const notice: ProposalNotice = {
  id: ID,
  proposer: "sales",
  target: "sales-sub-a1b2c3",
  actingUserId: "u-owner",
  reason: "Long quotes need the medium tier.",
  expiresAt: NOW + 72 * 3_600_000,
  fields: ["model", "tools"],
};

describe("Kelpie's notice of a proposal (#302)", () => {
  it("names both agents by id, the fields, the page as its one link, and the hours left", () => {
    expect(proposalBubble(notice, "en", "https://admin.example", NOW)).toEqual({
      text: `The agent sales proposes a change to the agent sales-sub-a1b2c3: model, tools. Review it, then approve or refuse it here: https://admin.example/proposals/${ID}?lang=en\nIt expires in 72 hours.`,
      link: `https://admin.example/proposals/${ID}?lang=en`,
    });
    expect(proposalBubble(notice, "pt-BR", "https://admin.example", NOW).text).toBe(
      `O agente sales propõe uma mudança no agente sales-sub-a1b2c3: modelo, tools. Revise e aprove ou recuse aqui: https://admin.example/proposals/${ID}?lang=pt-BR\nExpira em 72 horas.`,
    );
    expect(
      proposalBubble(
        { ...notice, fields: ["spawn", "systemPrompt"] },
        "es",
        "https://a.example",
        NOW,
      ).text,
    ).toContain("subagentes, alma. Revísalo");
    // The reason is the agent's: it never reaches the owner's bubble.
    expect(proposalBubble(notice, "en", "https://admin.example", NOW).text).not.toContain(
      "medium tier",
    );
  });

  it("counts at least an hour, and points to the admin API without an origin", () => {
    expect(
      proposalBubble({ ...notice, expiresAt: NOW + 60_000 }, "en", "https://admin.example", NOW)
        .text,
    ).toContain("It expires in 1 hour.");
    expect(proposalBubble(notice, "en", "", NOW)).toEqual({
      text: "The agent sales proposes a change to the agent sales-sub-a1b2c3: model, tools. Review it, then approve or refuse it on the admin API's proposals page.\nIt expires in 72 hours.",
    });
  });

  it("tells Master's model what happened, with the reason fenced as data and no link", () => {
    const note = proposalNote(notice);
    expect(note).toMatch(
      /^Kelpie, automatically \(not the owner\): the agent sales proposes a change to the agent sales-sub-a1b2c3: model, tools\./,
    );
    expect(note).toContain("nothing changes unless they approve it there");
    expect(note).toContain("Don't write a link");
    expect(note).toMatch(
      /<agent-words-[0-9a-f]{8}>\nLong quotes need the medium tier\.\n<\/agent-words-/,
    );
    expect(note).not.toContain("http");
  });
});
