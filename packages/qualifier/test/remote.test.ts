import { describe, expect, it, vi } from "vitest";
import { type GatewayQualifyOutcome, QualifierUnavailable, RemoteQualifier } from "../src/index.ts";

const questions = { "turn.end::user_finished": { type: "noul" as const, instructions: "Done?" } };

describe("RemoteQualifier", () => {
  it("returns the gateway's result as it is, provider included", async () => {
    const result = {
      answers: { "turn.end::user_finished": { type: "noul" as const, noul: 0.72 } },
      provider: "jev-http" as const,
      calibrated: true,
    };
    const call = vi.fn(async (): Promise<GatewayQualifyOutcome> => ({ ok: true, result }));
    expect(await new RemoteQualifier(call).qualify({ fragments: ["oi"] }, questions)).toBe(result);
    expect(call).toHaveBeenCalledWith({ fragments: ["oi"] }, questions);
  });

  it.each(["not_configured", "failed"] as const)(
    "fails with the reason when the gateway answers %s",
    async (reason) => {
      const qualifier = new RemoteQualifier(async () => ({ ok: false, reason }));
      const error = await qualifier.qualify({}, questions).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QualifierUnavailable);
      expect((error as QualifierUnavailable).reason).toBe(reason);
    },
  );
});
