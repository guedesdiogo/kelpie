import { describe, expect, it } from "vitest";
import { LlmError } from "../src/errors.ts";
import { ModelRouter, parseRouteTable, type RouteTable } from "../src/router.ts";
import type { LlmEvent, LlmProvider, LlmRequest, ProviderId } from "../src/types.ts";
import { collect } from "./fake-fetch.ts";

function finish(model: string): LlmEvent {
  return {
    type: "finish",
    reason: "stop",
    message: {
      role: "assistant",
      parts: [],
      native: { provider: "anthropic", model, content: [] },
    },
    usage: [],
  };
}

/** A provider that plays a script per model: events to send, then an optional error. */
function scripted(id: ProviderId, scripts: Record<string, { events?: LlmEvent[]; error?: Error }>) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    id,
    async *stream(request) {
      requests.push(request);
      const script = scripts[request.model] ?? {};
      yield* script.events ?? [finish(request.model)];
      if (script.error) throw script.error;
    },
  };
  return { provider, requests };
}

const routes: RouteTable = {
  cheap: [
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "openai", model: "gpt-6-luna" },
  ],
  medium: [{ provider: "anthropic", model: "claude-sonnet-5-5" }],
  frontier: [
    { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
    { provider: "openai", model: "gpt-6-astra" },
  ],
};

const request = {
  system: "You are Kelpie.",
  messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "Hi" }] }],
  maxOutputTokens: 1024,
};

const overloaded = new LlmError("overloaded", "server_error", true);

describe("ModelRouter", () => {
  it("uses the tier's first candidate, with its effort", async () => {
    const anthropic = scripted("anthropic", {});
    const router = new ModelRouter(routes, { anthropic: anthropic.provider });

    expect(await collect(router.stream({ tier: "frontier" }, request))).toEqual([
      finish("claude-opus-5-5"),
    ]);
    expect(anthropic.requests).toEqual([{ ...request, model: "claude-opus-5-5", effort: "high" }]);
  });

  it("passes a request's context on, and drops one that isn't text", async () => {
    const anthropic = scripted("anthropic", {});
    const router = new ModelRouter(routes, { anthropic: anthropic.provider });

    await collect(router.stream({ tier: "medium" }, { ...request, context: "<memory/>" }));
    await collect(
      router.stream({ tier: "medium" }, { ...request, context: 42 } as unknown as typeof request),
    );
    expect(anthropic.requests).toEqual([
      { ...request, model: "claude-sonnet-5-5", context: "<memory/>" },
      { ...request, model: "claude-sonnet-5-5" },
    ]);
  });

  it("falls back to the next candidate on a retryable error before any event", async () => {
    const anthropic = scripted("anthropic", {
      "claude-haiku-4-5": { events: [], error: overloaded },
    });
    const openai = scripted("openai", {});
    const router = new ModelRouter(routes, {
      anthropic: anthropic.provider,
      openai: openai.provider,
    });

    expect(await collect(router.stream({ tier: "cheap" }, request))).toEqual([
      {
        type: "fallback",
        failed: { provider: "anthropic", model: "claude-haiku-4-5", code: "server_error" },
        next: { provider: "openai", model: "gpt-6-luna" },
      },
      finish("gpt-6-luna"),
    ]);
    expect(openai.requests[0]).toEqual({ ...request, model: "gpt-6-luna" });
  });

  it("falls back when a route's credits are spent, and says so (#293)", async () => {
    const spent = new LlmError("credit balance is too low", "out_of_credits", true, 400);
    const anthropic = scripted("anthropic", { "claude-haiku-4-5": { events: [], error: spent } });
    const openai = scripted("openai", {});
    const router = new ModelRouter(routes, {
      anthropic: anthropic.provider,
      openai: openai.provider,
    });

    const events = await collect(router.stream({ tier: "cheap" }, request));
    expect(events[0]).toMatchObject({
      type: "fallback",
      failed: { provider: "anthropic", code: "out_of_credits" },
    });
    expect(events.at(-1)).toEqual(finish("gpt-6-luna"));
  });

  it("stops at the first failure when fallback is off, and tries no other route", async () => {
    const anthropic = scripted("anthropic", {
      "claude-haiku-4-5": { events: [], error: overloaded },
    });
    const openai = scripted("openai", {});
    const router = new ModelRouter(
      routes,
      { anthropic: anthropic.provider, openai: openai.provider },
      { fallback: false },
    );

    await expect(collect(router.stream({ tier: "cheap" }, request))).rejects.toMatchObject({
      code: "server_error",
      route: { provider: "anthropic", model: "claude-haiku-4-5" },
    });
    expect(openai.requests).toEqual([]);
  });

  it("doesn't fall back once an event has gone out", async () => {
    const anthropic = scripted("anthropic", {
      "claude-haiku-4-5": { events: [{ type: "text", delta: "Hel" }], error: overloaded },
    });
    const openai = scripted("openai", {});
    const router = new ModelRouter(routes, {
      anthropic: anthropic.provider,
      openai: openai.provider,
    });

    await expect(collect(router.stream({ tier: "cheap" }, request))).rejects.toBe(overloaded);
    expect(openai.requests).toEqual([]);
  });

  it.each([
    ["a non-retryable error", new LlmError("bad key", "auth", false)],
    ["an abort", new LlmError("aborted", "aborted", false)],
    ["an unexpected error", new TypeError("bug")],
  ])("doesn't fall back on %s", async (_label, error) => {
    const anthropic = scripted("anthropic", { "claude-haiku-4-5": { events: [], error } });
    const openai = scripted("openai", {});
    const router = new ModelRouter(routes, {
      anthropic: anthropic.provider,
      openai: openai.provider,
    });

    await expect(collect(router.stream({ tier: "cheap" }, request))).rejects.toBe(error);
    expect(openai.requests).toEqual([]);
  });

  it("doesn't fall back on a refusal, which is a finished reply", async () => {
    const refusal: LlmEvent = { ...finish("claude-haiku-4-5"), reason: "refusal" } as LlmEvent;
    const anthropic = scripted("anthropic", { "claude-haiku-4-5": { events: [refusal] } });
    const openai = scripted("openai", {});
    const router = new ModelRouter(routes, {
      anthropic: anthropic.provider,
      openai: openai.provider,
    });

    expect(await collect(router.stream({ tier: "cheap" }, request))).toEqual([refusal]);
    expect(openai.requests).toEqual([]);
  });

  it("throws the last error when every candidate fails", async () => {
    const lastError = new LlmError("rate limited", "rate_limited", true);
    const anthropic = scripted("anthropic", {
      "claude-haiku-4-5": { events: [], error: overloaded },
    });
    const openai = scripted("openai", { "gpt-6-luna": { events: [], error: lastError } });
    const router = new ModelRouter(routes, {
      anthropic: anthropic.provider,
      openai: openai.provider,
    });

    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of router.stream({ tier: "cheap" }, request)) seen.push(event);
      })(),
    ).rejects.toBe(lastError);
    // The failure before the last is reported; the last one is the error itself.
    expect(seen).toEqual([
      {
        type: "fallback",
        failed: { provider: "anthropic", model: "claude-haiku-4-5", code: "server_error" },
        next: { provider: "openai", model: "gpt-6-luna" },
      },
    ]);
  });

  it("skips candidates whose provider isn't configured", async () => {
    const openai = scripted("openai", {});
    const router = new ModelRouter(routes, { openai: openai.provider });

    expect(await collect(router.stream({ tier: "cheap" }, request))).toEqual([
      finish("gpt-6-luna"),
    ]);
    await expect(collect(router.stream({ tier: "medium" }, request))).rejects.toMatchObject({
      code: "unavailable",
      retryable: false,
    });
  });
});

describe("ModelRouter input from RPC", () => {
  it("rejects an unknown tier", async () => {
    const router = new ModelRouter(routes, { anthropic: scripted("anthropic", {}).provider });

    await expect(
      collect(router.stream({ tier: "constructor" as never }, request)),
    ).rejects.toMatchObject({
      code: "bad_request",
      retryable: false,
    });
  });

  it("takes only the request fields it knows", async () => {
    const anthropic = scripted("anthropic", {});
    const router = new ModelRouter(routes, { anthropic: anthropic.provider });
    const sneaky = { ...request, model: "claude-fable-5-1", effort: "max", baseURL: "https://x" };

    await collect(router.stream({ tier: "medium" }, sneaky as never));
    expect(anthropic.requests).toEqual([{ ...request, model: "claude-sonnet-5-5" }]);
  });

  it("tries the chosen provider's candidates first, then the tier's others in order", async () => {
    const anthropic = scripted("anthropic", {});
    const openai = scripted("openai", { "gpt-6-luna": { events: [], error: overloaded } });
    const router = new ModelRouter(routes, {
      anthropic: anthropic.provider,
      openai: openai.provider,
    });

    expect(await collect(router.stream({ tier: "cheap", provider: "openai" }, request))).toEqual([
      {
        type: "fallback",
        failed: { provider: "openai", model: "gpt-6-luna", code: "server_error" },
        next: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
      finish("claude-haiku-4-5"),
    ]);
    expect(openai.requests.map((sent) => sent.model)).toEqual(["gpt-6-luna"]);
    expect(anthropic.requests.map((sent) => sent.model)).toEqual(["claude-haiku-4-5"]);
    // No choice, or a provider without a key, keeps the table's order.
    expect(router.route("cheap", "openai").map((candidate) => candidate.provider)).toEqual([
      "openai",
      "anthropic",
    ]);
    expect(router.route("cheap", null).map((candidate) => candidate.provider)).toEqual([
      "anthropic",
      "openai",
    ]);
    const anthropicOnly = new ModelRouter(routes, { anthropic: anthropic.provider });
    expect(anthropicOnly.route("cheap", "openai").map((candidate) => candidate.provider)).toEqual([
      "anthropic",
    ]);
  });

  it("sends the chosen effort before the candidate's own, lowered to what the model takes", async () => {
    const anthropic = scripted("anthropic", {});
    const withOld: RouteTable = {
      ...routes,
      medium: [{ provider: "anthropic", model: "claude-opus-4-6" }],
    };
    const router = new ModelRouter(withOld, { anthropic: anthropic.provider });

    await collect(router.stream({ tier: "frontier", effort: "max" }, request));
    await collect(router.stream({ tier: "frontier" }, request));
    await collect(router.stream({ tier: "medium", effort: "xhigh" }, request));
    expect(anthropic.requests.map((sent) => sent.effort)).toEqual(["max", "high", "high"]);
  });

  it("lists a tier's candidates whose provider is configured, in order, without calling one", () => {
    const anthropic = scripted("anthropic", {});
    const openai = scripted("openai", {});
    const both = new ModelRouter(routes, {
      anthropic: anthropic.provider,
      openai: openai.provider,
    });

    expect(both.route("frontier")).toEqual(routes.frontier);
    expect(new ModelRouter(routes, { openai: openai.provider }).route("cheap")).toEqual([
      { provider: "openai", model: "gpt-6-luna" },
    ]);
    expect(new ModelRouter(routes, { openai: openai.provider }).route("medium")).toEqual([]);
    expect(anthropic.requests).toEqual([]);
    expect(openai.requests).toEqual([]);
  });

  it("refuses to list a tier it doesn't know", () => {
    const router = new ModelRouter(routes, {});
    expect(() => router.route("huge" as never)).toThrow(LlmError);
  });
});

describe("parseRouteTable", () => {
  it("accepts a complete table and drops unknown keys", () => {
    const withExtra = { ...routes, medium: [{ ...routes.medium[0], note: "x" }] };
    expect(parseRouteTable(withExtra)).toEqual(routes);
  });

  it.each([
    ["a missing tier", { cheap: routes.cheap, medium: routes.medium }, /"frontier"/],
    ["an unknown provider", { ...routes, medium: [{ provider: "gemini", model: "x" }] }, /gemini/],
    ["a candidate without a model", { ...routes, medium: [{ provider: "openai" }] }, /no model/],
    ["a candidate that isn't an object", { ...routes, medium: [null] }, /isn't an object/],
    [
      "an unknown effort",
      { ...routes, medium: [{ provider: "openai", model: "x", effort: "huge" }] },
      /huge/,
    ],
  ])("rejects %s", (_label, table, message) => {
    expect(() => parseRouteTable(table)).toThrow(message);
  });
});
