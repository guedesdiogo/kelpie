import { describe, expect, it, vi } from "vitest";
import { endOfTurn, type JevFetch, JevHttpQualifier, type Question } from "../src/index.ts";

// Recorded from TypeSafe's API in the Jev spike (issue #27), with jev-1.13.0.
const RECORDED = {
  model: "jev-1.13.0",
  answers: { "turn.end::user_finished": { type: "noul", noul: 0.87 } },
  usage: { input_tokens: 312, output_tokens: 24 },
};

const questions: Record<string, Question> = {
  "turn.end::user_finished": endOfTurn.questions({ fragments: [] }).user_finished as Question,
};

const answering = (status: number, body: unknown) =>
  vi.fn<JevFetch>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));

const jev = (fetch: JevFetch) =>
  new JevHttpQualifier({ apiKey: "ts-key", model: "jev-1.13.0", fetch });

describe("JevHttpQualifier", () => {
  it("posts the questions with the pinned model and the key, and maps the answers", async () => {
    const fetch = answering(200, RECORDED);
    const result = await jev(fetch).qualify(
      { fragments: ["vocês entregam em Niterói?"] },
      questions,
    );

    expect(result).toEqual({
      answers: { "turn.end::user_finished": { type: "noul", noul: 0.87 } },
      provider: "jev-http",
      calibrated: true,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      authorization: "Bearer ts-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(init?.body ?? "")).toEqual({
      model: "jev-1.13.0",
      state: { fragments: ["vocês entregam em Niterói?"] },
      questions,
    });
  });

  it("masks personal data in the state before it leaves, and keeps the instructions", async () => {
    const fetch = answering(200, RECORDED);
    await jev(fetch).qualify(
      { fragments: ["meu cpf é 123.456.789-09", "email ana@exemplo.com"] },
      questions,
    );

    const body = fetch.mock.calls[0]?.[1].body ?? "";
    expect(body).not.toContain("123.456.789-09");
    expect(body).not.toContain("ana@exemplo.com");
    expect(JSON.parse(body).state).toEqual({ fragments: ["meu cpf é [number]", "email [email]"] });
    expect(JSON.parse(body).questions).toEqual(questions);
  });

  it("passes the caller's abort signal to the request", async () => {
    const fetch = answering(200, RECORDED);
    const controller = new AbortController();
    await jev(fetch).qualify({}, questions, { signal: controller.signal });
    expect(fetch.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });

  it("fails on an error status without repeating the body, which can echo the state", async () => {
    const fetch = answering(422, { detail: "state: meu cpf é 12345678909" });
    const call = jev(fetch).qualify({ fragments: ["oi"] }, questions);
    await expect(call).rejects.toThrow("TypeSafe answered 422");
    await expect(call).rejects.not.toThrow(/cpf/);
  });

  it("fails with a fixed message when the body isn't JSON", async () => {
    const fetch = vi.fn<JevFetch>(async () => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse("<html>meu cpf 12345678909</html>"),
    }));
    const call = jev(fetch).qualify({}, questions);
    await expect(call).rejects.toThrow("TypeSafe answered with a body that isn't JSON");
    await expect(call).rejects.not.toThrow(/cpf|html/);
  });

  it("drops an answer whose shape doesn't match its question", async () => {
    const fetch = answering(200, {
      answers: {
        "turn.end::user_finished": { type: "noul", noul: "high" },
        unknown: { type: "noul", noul: 0.5 },
      },
    });
    const result = await jev(fetch).qualify({}, questions);
    expect(result.answers).toEqual({});
  });

  it("maps choice and score answers to the shared shapes", async () => {
    const typed: Record<string, Question> = {
      tier: {
        type: "choice",
        instructions: "Which tier?",
        criteria: { cheap: null, frontier: null },
      },
      urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "high"] },
      wrong: { type: "noul", instructions: "Anything?" },
    };
    const fetch = answering(200, {
      answers: {
        tier: {
          type: "choice",
          choice: "cheap",
          probabilities: { cheap: 0.9, frontier: 0.1 },
          confidence: 0.9,
        },
        urgency: {
          type: "score",
          score: 1,
          legend: { "0": "low", "1": "high" },
          probabilities: { "0": 0.2, "1": 0.8 },
          confidence: 0.8,
        },
        wrong: { type: "choice", choice: "yes", probabilities: { yes: 1 } },
      },
    });
    const result = await jev(fetch).qualify({}, typed);
    expect(result.answers).toEqual({
      tier: { type: "choice", choice: "cheap", probabilities: { cheap: 0.9, frontier: 0.1 } },
      urgency: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8 } },
    });
  });
});
