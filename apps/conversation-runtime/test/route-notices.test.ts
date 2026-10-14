import type { FallbackEvent } from "@kelpie/llm";
import { describe, expect, it } from "vitest";
import { failureNotice, ROUTE_NOTICE_REPEAT_MS, routeNotice } from "../src/route-notices.ts";

const spent: FallbackEvent = {
  type: "fallback",
  failed: { provider: "anthropic", model: "claude-haiku-5-5", code: "out_of_credits" },
  next: { provider: "openai", model: "gpt-6-luna" },
};
const busy: FallbackEvent = {
  type: "fallback",
  failed: { provider: "openai", model: "gpt-6-luna", code: "rate_limited" },
  next: { provider: "anthropic", model: "claude-sonnet-5-5" },
};
const NOW = 1_800_000_000_000;

describe("routeNotice", () => {
  it("names the route that failed, why, and the one that answered, in the conversation's language", () => {
    expect(routeNotice([spent], {}, NOW, "en").text).toBe(
      "Note: Anthropic (claude-haiku-5-5) ran out of credits, or reached its spend limit, so OpenAI (gpt-6-luna) answered.",
    );
    expect(routeNotice([spent], {}, NOW, "pt-BR").text).toBe(
      "Aviso: Anthropic (claude-haiku-5-5) ficou sem créditos ou atingiu o limite de gastos, então OpenAI (gpt-6-luna) respondeu.",
    );
    expect(routeNotice([spent], {}, NOW, "es").text).toBe(
      "Aviso: Anthropic (claude-haiku-5-5) se quedó sin créditos o alcanzó su límite de gasto, así que respondió OpenAI (gpt-6-luna).",
    );
  });

  it("gives each fallback of the turn its own line, once", () => {
    const { text } = routeNotice([spent, busy, spent], {}, NOW, "en");
    expect(text?.split("\n")).toEqual([
      "Note: Anthropic (claude-haiku-5-5) ran out of credits, or reached its spend limit, so OpenAI (gpt-6-luna) answered.",
      "Note: OpenAI (gpt-6-luna) is rate limiting requests, so Anthropic (claude-sonnet-5-5) answered.",
    ]);
  });

  it("says nothing for a route and reason announced in the last day, then says it again", () => {
    const first = routeNotice([spent], {}, NOW, "en");
    expect(first.text).not.toBeNull();
    const soon = routeNotice([spent], first.announced, NOW + ROUTE_NOTICE_REPEAT_MS - 1, "en");
    expect(soon.text).toBeNull();
    expect(soon.announced).toEqual(first.announced);
    // Another reason on the same route is news.
    const other = { ...spent, failed: { ...spent.failed, code: "rate_limited" as const } };
    expect(routeNotice([other], first.announced, NOW + 1, "en").text).toContain("rate limiting");
    const later = routeNotice([spent], first.announced, NOW + ROUTE_NOTICE_REPEAT_MS, "en");
    expect(later.text).not.toBeNull();
  });

  it("forgets what it announced more than a day ago", () => {
    const old = routeNotice([busy], {}, NOW, "en").announced;
    const { announced } = routeNotice([spent], old, NOW + ROUTE_NOTICE_REPEAT_MS + 1, "en");
    expect(Object.keys(announced)).toEqual(["anthropic:claude-haiku-5-5:out_of_credits"]);
  });

  it("is null without a fallback", () => {
    expect(routeNotice([], {}, NOW, "en")).toEqual({ text: null, announced: {} });
  });
});

describe("failureNotice", () => {
  it("says no route answered, naming each one when the turn fell back", () => {
    expect(failureNotice([spent], "rate_limited", "en")).toBe(
      "I couldn't answer this message: Anthropic (claude-haiku-5-5) ran out of credits, or reached its spend limit; OpenAI (gpt-6-luna) is rate limiting requests.",
    );
  });

  it("speaks of the model when the only route failed, or fallback is off", () => {
    expect(failureNotice([], "out_of_credits", "en")).toBe(
      "I couldn't answer this message: the model ran out of credits, or reached its spend limit.",
    );
    expect(failureNotice([], "auth", "pt-BR")).toBe(
      "Não consegui responder a esta mensagem: o modelo recusou a chave do Kelpie.",
    );
    expect(failureNotice([], "server_error", "es")).toBe(
      "No pude responder a este mensaje: el modelo no está disponible.",
    );
  });

  it.each([
    ["connection", "is unavailable"],
    ["unavailable", "isn't configured"],
    ["protocol", "answered in a way Kelpie can't read"],
    ["bad_request", "refused the request"],
    ["internal", "failed"],
  ] as const)("words %s", (code, words) => {
    expect(failureNotice([], code, "en")).toContain(words);
  });
});
