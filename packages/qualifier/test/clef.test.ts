import { describe, expect, it, vi } from "vitest";
import { ClefQualifier, type ClefRun, endOfTurn, type Question } from "../src/index.ts";

// Recorded from Workers AI in spike #117 (2026-10-06, clef-flash, "vocês entregam em Niterói?").
const RECORDED = {
  model: "clef-flash",
  answers: { "turn.end__user_finished": { type: "noul", noul: 0.9323 } },
  usage: { input_tokens: 181, output_tokens: 0 },
};

const question = endOfTurn.questions({ fragments: [] }).user_finished as Question;
const questions: Record<string, Question> = { "turn.end::user_finished": question };

const answering = (body: unknown) => vi.fn<ClefRun>(async () => body);

const clef = (run: ClefRun) => new ClefQualifier({ model: "clef-flash", run });

describe("ClefQualifier", () => {
  it("runs the Workers AI model with its selector and maps the answers", async () => {
    const run = answering(RECORDED);
    const result = await clef(run).qualify(
      { fragments: ["vocês entregam em Niterói?"] },
      questions,
    );

    expect(result).toEqual({
      answers: { "turn.end::user_finished": { type: "noul", noul: 0.9323 } },
      provider: "clef-flash-workers-ai",
      calibrated: true,
    });
    const [model, input] = run.mock.calls[0] ?? [];
    expect(model).toBe("@cf/cloudflare/clef-flash");
    // Clef accepts question ids of [A-Za-z0-9_.-] only, so `::` goes out as `__` and comes back.
    expect(input).toEqual({
      model: "clef-flash",
      state: { fragments: ["vocês entregam em Niterói?"] },
      questions: { "turn.end__user_finished": question },
    });
  });

  it("names each model as its own provider, because their bands differ", async () => {
    const run = answering(RECORDED);
    const full = new ClefQualifier({ model: "clef", run });
    expect((await full.qualify({}, questions)).provider).toBe("clef-workers-ai");
    expect(run.mock.calls[0]?.[0]).toBe("@cf/cloudflare/clef");
  });

  it("masks personal data in the state before it leaves, and keeps the instructions", async () => {
    const run = answering(RECORDED);
    await clef(run).qualify(
      { fragments: ["meu cpf é 123.456.789-09", "email ana@exemplo.com"] },
      questions,
    );

    const input = run.mock.calls[0]?.[1];
    expect(JSON.stringify(input)).not.toMatch(/123\.456|ana@exemplo/);
    expect(input?.state).toEqual({ fragments: ["meu cpf é [number]", "email [email]"] });
    expect(input?.questions).toEqual({ "turn.end__user_finished": question });
  });

  it("passes the caller's abort signal to the run", async () => {
    const run = answering(RECORDED);
    const controller = new AbortController();
    await clef(run).qualify({}, questions, { signal: controller.signal });
    expect(run.mock.calls[0]?.[2]).toEqual({ signal: controller.signal });
  });

  it("stops waiting when the caller aborts, even if the run ignores the signal", async () => {
    const run = vi.fn<ClefRun>(() => new Promise(() => {}));
    const controller = new AbortController();
    const call = clef(run).qualify({}, questions, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toThrow("Workers AI failed: AbortError");
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
        "turn.end__user_finished": { type: "score", score: 1, probabilities: { "0": 1 } },
        unknown: { type: "noul", noul: 0.5 },
      },
    });
    const result = await clef(run).qualify({}, questions);
    expect(result.answers).toEqual({});
  });
});
