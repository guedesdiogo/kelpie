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
    expect(Object.keys(announced)).toEqual(["anthropic:claude-haiku-5-5:credits"]);
  });

  it("counts two codes worded alike as one reason", () => {
    const down = (code: "server_error" | "connection") => ({
      ...spent,
      failed: { ...spent.failed, code },
    });
    const first = routeNotice([down("server_error")], {}, NOW, "en");
    expect(routeNotice([down("connection")], first.announced, NOW + 1, "en").text).toBeNull();
  });

  it("is null without a fallback", () => {
    expect(routeNotice([], {}, NOW, "en")).toEqual({ text: null, announced: {} });
  });
});

describe("failureNotice", () => {
  it("says no route answered, naming each one when the turn fell back", () => {
    expect(failureNotice([spent], { code: "rate_limited" }, "en")).toBe(
      "I couldn't answer this message: Anthropic (claude-haiku-5-5) ran out of credits, or reached its spend limit; OpenAI (gpt-6-luna) is rate limiting requests.",
    );
  });

  it("names the route the error names, when the call never fell back", () => {
    const anthropic = { provider: "anthropic" as const, model: "claude-haiku-5-5" };
    expect(failureNotice([], { code: "out_of_credits", route: anthropic }, "en")).toBe(
      "I couldn't answer this message: Anthropic (claude-haiku-5-5) ran out of credits, or reached its spend limit.",
    );
    expect(failureNotice([], { code: "auth", route: anthropic }, "pt-BR")).toBe(
      "Não consegui responder a esta mensagem: Anthropic (claude-haiku-5-5) recusou a chave do Kelpie.",
    );
  });

  it("names each route once, however many times the call fell back from it", () => {
    expect(failureNotice([spent, spent], { code: "rate_limited", route: spent.next }, "en")).toBe(
      "I couldn't answer this message: Anthropic (claude-haiku-5-5) ran out of credits, or reached its spend limit; OpenAI (gpt-6-luna) is rate limiting requests.",
    );
  });

  it("names Claude Code's route by its product name (#295)", () => {
    const claudeCode = { provider: "claude-code" as const, model: "claude-sonnet-5-5" };
    expect(failureNotice([], { code: "server_error", route: claudeCode }, "en")).toBe(
      "I couldn't answer this message: Claude Code (claude-sonnet-5-5) is unavailable.",
    );
  });

  it("speaks of the model only when no route is known, as for a tier with none", () => {
    expect(failureNotice([], { code: "unavailable" }, "es")).toBe(
      "No pude responder a este mensaje: el modelo no está disponible.",
    );
  });

  it.each([
    ["connection", "is unavailable"],
    ["unavailable", "is unavailable"],
    ["protocol", "answered in a way Kelpie can't read"],
    ["bad_request", "refused the request"],
    ["internal", "failed"],
  ] as const)("words %s", (code, words) => {
    expect(failureNotice([], { code }, "en")).toContain(words);
  });
});
