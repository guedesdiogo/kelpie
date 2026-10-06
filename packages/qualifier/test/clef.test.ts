import { describe, expect, it, vi } from "vitest";
import { ClefQualifier, type ClefRun, endOfTurn, type Question } from "../src/index.ts";

// Built by hand from the documented output schema of @cf/cloudflare/clef-flash (2026-10-06).
// Replace it with a recorded answer once spike #117 has one.
const DOCUMENTED = {
  model: "clef-flash",
  answers: { "turn.end::user_finished": { type: "noul", noul: 0.81 } },
  usage: { input_tokens: 300, output_tokens: 1 },
};

const questions: Record<string, Question> = {
  "turn.end::user_finished": endOfTurn.questions({ fragments: [] }).user_finished as Question,
};

const answering = (body: unknown) => vi.fn<ClefRun>(async () => body);

const clef = (run: ClefRun) => new ClefQualifier({ model: "clef-flash", run });

describe("ClefQualifier", () => {
  it("runs the Workers AI model with its selector and maps the answers", async () => {
    const run = answering(DOCUMENTED);
    const result = await clef(run).qualify(
      { fragments: ["vocês entregam em Niterói?"] },
      questions,
    );

    expect(result).toEqual({
      answers: { "turn.end::user_finished": { type: "noul", noul: 0.81 } },
      provider: "clef-workers-ai",
      calibrated: true,
    });
    const [model, input] = run.mock.calls[0] ?? [];
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(input).toEqual({
      model: "clef-flash",
      state: { fragments: ["vocês entregam em Niterói?"] },
      questions,
    });
  });

  it("masks personal data in the state before it leaves, and keeps the instructions", async () => {
    const run = answering(DOCUMENTED);
    await clef(run).qualify(
      { fragments: ["meu cpf é 123.456.789-09", "email ana@exemplo.com"] },
      questions,
    );

    const input = run.mock.calls[0]?.[1];
    expect(JSON.stringify(input)).not.toMatch(/123\.456|ana@exemplo/);
    expect(input?.state).toEqual({ fragments: ["meu cpf é [number]", "email [email]"] });
    expect(input?.questions).toEqual(questions);
  });

  it("passes the caller's abort signal to the run", async () => {
    const run = answering(DOCUMENTED);
    const controller = new AbortController();
    await clef(run).qualify({}, questions, { signal: controller.signal });
    expect(run.mock.calls[0]?.[2]).toEqual({ signal: controller.signal });
  });

  it("fails with the error's name only, because its message can quote the state", async () => {
    const run = vi.fn<ClefRun>(async () => {
      const error = new Error("InferenceUpstreamError: bad input: meu cpf é 12345678909");
      error.name = "InferenceUpstreamError";
      throw error;
    });
    const call = clef(run).qualify({ fragments: ["oi"] }, questions);
    await expect(call).rejects.toThrow("Workers AI failed: InferenceUpstreamError");
    await expect(call).rejects.not.toThrow(/cpf/);
  });

  it("drops an answer whose shape doesn't match its question", async () => {
    const run = answering({
      answers: {
        "turn.end::user_finished": { type: "score", score: 1, probabilities: { "0": 1 } },
        unknown: { type: "noul", noul: 0.5 },
      },
    });
    const result = await clef(run).qualify({}, questions);
    expect(result.answers).toEqual({});
  });
});
