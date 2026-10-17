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

  it.each([
    ["en", "I couldn't answer this message: Claude Code (claude-sonnet-5-5) is unavailable."],
    [
      "pt-BR",
      "Não consegui responder a esta mensagem: Claude Code (claude-sonnet-5-5) está fora do ar.",
    ],
    ["es", "No pude responder a este mensaje: Claude Code (claude-sonnet-5-5) no está disponible."],
  ] as const)("names Claude Code's route by its product name, in %s (#295)", (locale, text) => {
    const claudeCode = { provider: "claude-code" as const, model: "claude-sonnet-5-5" };
    expect(failureNotice([], { code: "server_error", route: claudeCode }, locale)).toBe(text);
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

describe("Claude Code's failures (#295)", () => {
  const claudeCode = { provider: "claude-code" as const, model: "claude-sonnet-5-5" };
  const anthropic = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };
  /** 21:00 UTC on Saturday 17 October 2026: 18:00 in São Paulo. */
  const RESETS_AT = Date.UTC(2026, 9, 17, 21, 0);
  const fellBackFrom = (failed: Omit<FallbackEvent["failed"], "provider" | "model">) => ({
    type: "fallback" as const,
    failed: { ...claudeCode, ...failed },
    next: anthropic,
  });
  const limit = fellBackFrom({ code: "rate_limited", resetsAt: RESETS_AT });

  it.each([
    [
      "en",
      "Note: Claude Code (claude-sonnet-5-5) reached its usage limit until Oct 17, 18:00, so Anthropic (claude-sonnet-5-5) answered.",
    ],
    [
      "pt-BR",
      "Aviso: Claude Code (claude-sonnet-5-5) atingiu o limite de uso até 17 de out., 18:00, então Anthropic (claude-sonnet-5-5) respondeu.",
    ],
    [
      "es",
      "Aviso: Claude Code (claude-sonnet-5-5) alcanzó su límite de uso hasta 17 oct, 18:00, así que respondió Anthropic (claude-sonnet-5-5).",
    ],
  ] as const)(
    "words a limit with its reset in the conversation's time zone, in %s",
    (locale, text) => {
      expect(routeNotice([limit], {}, NOW, locale, "America/Sao_Paulo").text).toBe(text);
    },
  );

  it("says the reset in UTC when the conversation has no time zone, and fails with it too", () => {
    expect(
      failureNotice([], { code: "rate_limited", route: claudeCode, resetsAt: RESETS_AT }, "en"),
    ).toBe(
      "I couldn't answer this message: Claude Code (claude-sonnet-5-5) reached its usage limit until Oct 17, 21:00 UTC.",
    );
  });

  it("names a limit once a day, whatever its reset, apart from plain rate limiting", () => {
    const first = routeNotice([limit], {}, NOW, "en");
    const later = fellBackFrom({ code: "rate_limited", resetsAt: RESETS_AT + 5 * 60 * 60_000 });
    expect(routeNotice([later], first.announced, NOW + 1, "en").text).toBeNull();
    const busy = fellBackFrom({ code: "rate_limited" });
    expect(routeNotice([busy], first.announced, NOW + 1, "en").text).toBe(
      "Note: Claude Code (claude-sonnet-5-5) is rate limiting requests, so Anthropic (claude-sonnet-5-5) answered.",
    );
  });

  it.each([
    [
      "en",
      "Note: Claude Code (claude-sonnet-5-5) may have run out of usage, which Kelpie can't confirm, so Anthropic (claude-sonnet-5-5) answered.",
      "I couldn't answer this message: Claude Code (claude-sonnet-5-5) may have run out of usage, which Kelpie can't confirm.",
    ],
    [
      "pt-BR",
      "Aviso: Claude Code (claude-sonnet-5-5) pode ter esgotado o uso, o que o Kelpie não consegue confirmar, então Anthropic (claude-sonnet-5-5) respondeu.",
      "Não consegui responder a esta mensagem: Claude Code (claude-sonnet-5-5) pode ter esgotado o uso, o que o Kelpie não consegue confirmar.",
    ],
    [
      "es",
      "Aviso: Claude Code (claude-sonnet-5-5) puede haber agotado su uso, algo que Kelpie no puede confirmar, así que respondió Anthropic (claude-sonnet-5-5).",
      "No pude responder a este mensaje: Claude Code (claude-sonnet-5-5) puede haber agotado su uso, algo que Kelpie no puede confirmar.",
    ],
  ] as const)(
    "doesn't claim usage ran out when it can't confirm it, in %s",
    (locale, note, failed) => {
      const spent = fellBackFrom({ code: "out_of_credits", unverified: true });
      expect(routeNotice([spent], {}, NOW, locale).text).toBe(note);
      const error = { code: "out_of_credits" as const, route: claudeCode, unverified: true };
      expect(failureNotice([], error, locale)).toBe(failed);
    },
  );

  it.each([
    [
      "en",
      "I couldn't answer this message: Claude Code (claude-sonnet-5-5) needs its login on the server renewed.",
    ],
    [
      "pt-BR",
      "Não consegui responder a esta mensagem: Claude Code (claude-sonnet-5-5) precisa que o login no servidor seja renovado.",
    ],
    [
      "es",
      "No pude responder a este mensaje: Claude Code (claude-sonnet-5-5) necesita que se renueve su sesión en el servidor.",
    ],
  ] as const)("says Claude Code's login needs renewing, never a key, in %s", (locale, text) => {
    expect(failureNotice([], { code: "auth", route: claudeCode }, locale)).toBe(text);
    // Its fallback is named the same way.
    expect(routeNotice([fellBackFrom({ code: "auth" })], {}, NOW, locale).text).toContain(
      text.slice(text.indexOf("Claude Code"), -1),
    );
  });
});
