import { env, exports } from "cloudflare:workers";
import type { ProviderKeysOutcome, StoredModelKeys } from "@kelpie/channels";
import { fromNdjsonStream, type RoutedRequest, type RouterEvent } from "@kelpie/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  embedWith,
  generateWith,
  instanceModelsWith,
  ProviderCheck,
  providersWith,
  qualifyWith,
} from "../src/index.ts";
import { checkModelKey } from "../src/provider-check.ts";
import {
  forgetStoredKeysForTesting,
  KEYS_FRESH_MS,
  KEYS_KEPT_MS,
  withStoredKeys,
} from "../src/stored-keys.ts";

// Model keys set through a one-time form (ADR-0068): llm-gateway reads them from channel-egress's
// `ProviderKeys`, keeps one at most 60 s, prefers it to the Worker secret, and falls back to the
// last key read, then to the Worker secret. Its `ProviderCheck` checks a candidate key with a cheap
// authenticated read on its service, and keeps nothing.

type GatewayEnv = Parameters<typeof generateWith>[0];

const STORED_ANTHROPIC = `sk-ant-api03-${"s".repeat(80)}`;
const ROTATED_ANTHROPIC = `sk-ant-api03-${"r".repeat(80)}`;
const STORED_OPENAI = `sk-proj-${"o".repeat(120)}`;
const STORED_TYPESAFE = `ts-${"t".repeat(40)}`;
const STORED_GATEWAY = `cfut_${"g".repeat(40)}`;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const GATEWAY_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/kelpie`;

/** A stand-in for channel-egress's `ProviderKeys`, answering what a test sets; it counts reads. */
function providerKeys(answer: () => ProviderKeysOutcome | Promise<ProviderKeysOutcome>) {
  const binding = {
    reads: 0,
    async keys() {
      binding.reads += 1;
      return answer();
    },
  };
  return binding;
}

const storing = (keys: StoredModelKeys) => providerKeys(() => ({ ok: true, keys }));
const withKeys = (binding: unknown, extra: Partial<GatewayEnv> = {}) =>
  ({ ...(env as GatewayEnv), PROVIDER_KEYS: binding, ...extra }) as unknown as GatewayEnv;

const request: RoutedRequest = {
  system: "You are Kelpie.",
  messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
  maxOutputTokens: 64,
};

/** An Anthropic stub: a short stream for a message, the models list for the alias. */
function anthropicApi() {
  const encoder = new TextEncoder();
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Oi" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return new Response(encoder.encode(body.join("")), {
      headers: { "content-type": "text/event-stream" },
    });
  });
}

async function drain(generation: { events(): ReadableStream<Uint8Array> }) {
  const events: RouterEvent[] = [];
  for await (const event of fromNdjsonStream(generation.events())) events.push(event);
  return events;
}

/** Every log line, for checks that no key reaches one. */
function captureLogs() {
  const logged: unknown[][] = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => {
      logged.push(args);
    });
  }
  return logged;
}

beforeEach(() => forgetStoredKeysForTesting());
afterEach(() => {
  forgetStoredKeysForTesting();
  vi.restoreAllMocks();
});

describe("the stored keys", () => {
  it("are read once, served from memory for 30 s, and read again after, so a rotation applies within a minute", async () => {
    let stored: StoredModelKeys = { anthropic: STORED_ANTHROPIC };
    const binding = providerKeys(() => ({ ok: true, keys: stored }));
    const keyed = withKeys(binding);
    const at = 1_000_000;
    expect((await withStoredKeys(keyed, at)).env.ANTHROPIC_API_KEY).toBe(STORED_ANTHROPIC);
    stored = { anthropic: ROTATED_ANTHROPIC };
    expect((await withStoredKeys(keyed, at + KEYS_FRESH_MS - 1)).env.ANTHROPIC_API_KEY).toBe(
      STORED_ANTHROPIC,
    );
    expect(binding.reads).toBe(1);
    expect((await withStoredKeys(keyed, at + KEYS_FRESH_MS)).env.ANTHROPIC_API_KEY).toBe(
      ROTATED_ANTHROPIC,
    );
    expect(binding.reads).toBe(2);
  });

  it("share one read among calls that need it at once", async () => {
    const binding = storing({ openai: STORED_OPENAI });
    const keyed = withKeys(binding);
    const all = await Promise.all([1, 2, 3].map(() => withStoredKeys(keyed, 5_000)));
    expect(all.map((one) => one.env.OPENAI_API_KEY)).toEqual([
      STORED_OPENAI,
      STORED_OPENAI,
      STORED_OPENAI,
    ]);
    expect(binding.reads).toBe(1);
  });

  it("fall back to the last key read while it is under 60 s old, then to the Worker secret", async () => {
    const logged = captureLogs();
    let up = true;
    const binding = providerKeys(() => {
      if (!up) throw new Error(`down ${STORED_ANTHROPIC}`);
      return { ok: true, keys: { anthropic: STORED_ANTHROPIC } };
    });
    const keyed = withKeys(binding);
    const at = 2_000_000;
    await withStoredKeys(keyed, at);
    up = false;
    const failed = await withStoredKeys(keyed, at + KEYS_FRESH_MS);
    expect(failed.env.ANTHROPIC_API_KEY).toBe(STORED_ANTHROPIC);
    expect(failed.sources.anthropic).toBe("form");
    // A failed read isn't tried again on every call: the next try waits as a read would.
    await withStoredKeys(keyed, at + KEYS_FRESH_MS + 1);
    expect(binding.reads).toBe(2);
    const late = await withStoredKeys(keyed, at + KEYS_KEPT_MS);
    expect(late.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(late.sources.anthropic).toBe("deploy");
    expect(JSON.stringify(logged)).not.toContain(STORED_ANTHROPIC);
    expect(JSON.stringify(logged)).toContain("llm-gateway: the stored model keys couldn't be read");
  });

  it("use the Worker secrets when the store can't answer, or answers what isn't a key", async () => {
    captureLogs();
    for (const answer of [
      () => ({ ok: false, reason: "store_unavailable" }) as const,
      () => ({ ok: true, keys: { anthropic: "short" } }) as ProviderKeysOutcome,
      () => new Promise<ProviderKeysOutcome>(() => {}),
    ]) {
      forgetStoredKeysForTesting();
      const { env: keyed, sources } = await withStoredKeys(withKeys(providerKeys(answer)), 9_000);
      expect(keyed.ANTHROPIC_API_KEY).toBe("sk-ant-test");
      expect(keyed.TYPESAFE_API_KEY).toBe("ts-test");
      expect(sources).toEqual({
        anthropic: "deploy",
        openai: "none",
        "ai-gateway": "none",
        typesafe: "deploy",
      });
    }
  });
});

describe("a stored key in a model call", () => {
  it("takes the Worker secret's place, and the Worker secret serves when none is stored", async () => {
    const fetched = anthropicApi();
    await drain(
      generateWith(withKeys(storing({ anthropic: STORED_ANTHROPIC })), "medium", request),
    );
    forgetStoredKeysForTesting();
    await drain(generateWith(withKeys(storing({})), "medium", request));
    const keys = fetched.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-api-key"));
    expect(keys).toEqual([STORED_ANTHROPIC, "sk-ant-test"]);
  });

  it("makes its provider serve, and get_models says where each key comes from, never the key", async () => {
    const keyed = withKeys(storing({ openai: STORED_OPENAI, "ai-gateway": STORED_GATEWAY }));
    expect(await providersWith(keyed)).toEqual(["anthropic", "openai"]);
    const models = await instanceModelsWith(keyed);
    expect(models.keys).toEqual({
      anthropic: "deploy",
      openai: "form",
      "ai-gateway": "form",
      typesafe: "deploy",
    });
    expect(JSON.stringify(models)).not.toContain(STORED_OPENAI);
    expect(JSON.stringify(models)).not.toContain(STORED_GATEWAY);
  });

  it("serves Jev, OpenAI's embeddings and AI Gateway's token", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("typesafe")
        ? Response.json({ model: "jev-1.13.0", answers: {}, usage: {} })
        : Response.json({
            data: [{ index: 0, embedding: [0.1, 0.2] }],
            model: "text-embedding-3-small",
          }),
    );
    const keyed = withKeys(
      storing({
        typesafe: STORED_TYPESAFE,
        openai: STORED_OPENAI,
        "ai-gateway": STORED_GATEWAY,
      }),
      { EMBEDDING_PROVIDER: "openai", OPENAI_BASE_URL: `${GATEWAY_URL}/openai` },
    );
    await qualifyWith(keyed, {}, {}, "jev");
    await embedWith(keyed, ["note"]);
    const headers = fetched.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(headers[0]?.get("authorization")).toBe(`Bearer ${STORED_TYPESAFE}`);
    expect(headers[1]?.get("authorization")).toBe(`Bearer ${STORED_OPENAI}`);
    expect(headers[1]?.get("cf-aig-authorization")).toBe(`Bearer ${STORED_GATEWAY}`);
  });
});

describe("ProviderCheck", () => {
  /** A stub for every service a check reads, answering `status` for the paths a test names. */
  function services(answer: (url: URL) => Response | Promise<Response>) {
    const seen: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      return answer(new URL(request.url));
    });
    return seen;
  }

  it("is the one thing its entrypoint does, which only channel-egress's forms reach", () => {
    expect(
      Object.getOwnPropertyNames(ProviderCheck.prototype).filter((name) => name !== "constructor"),
    ).toEqual(["check"]);
  });

  it.each([
    ["anthropic", "https://api.anthropic.com/v1/models?limit=1", "x-api-key", STORED_ANTHROPIC],
    ["openai", "https://api.openai.com/v1/models", "authorization", `Bearer ${STORED_OPENAI}`],
    ["typesafe", "https://api.typesafe.ai/v1/models", "authorization", `Bearer ${STORED_TYPESAFE}`],
  ] as const)(
    "checks %s's key by listing its models, and keeps nothing",
    async (name, url, header, sent) => {
      const value = sent.replace("Bearer ", "");
      const seen = services(() => Response.json({ data: [] }));
      expect(await exports.ProviderCheck.check(name, value)).toBe("accepted");
      expect(seen.map((one) => [one.method, one.url, one.headers.get(header)])).toEqual([
        ["GET", url, sent],
      ]);
      expect(seen[0]?.redirect).toBe("manual");
      // Nothing kept: the model calls still use what serves.
      expect(await providersWith(env as GatewayEnv)).toEqual(["anthropic"]);
    },
  );

  it.each([
    [401, "refused"],
    [403, "refused"],
    [429, "unreachable"],
    [500, "unreachable"],
    [302, "unreachable"],
  ] as const)("reads a provider's %i as %s", async (status, check) => {
    services(() => new Response(null, { status, headers: { location: "https://elsewhere.test" } }));
    expect(await checkModelKey(env as GatewayEnv, "anthropic", STORED_ANTHROPIC)).toBe(check);
  });

  it("stores an OpenAI key that can't list models unchecked: a restricted key gets a 403", async () => {
    services(() => Response.json({ error: { message: "Missing scopes" } }, { status: 403 }));
    expect(await checkModelKey(env as GatewayEnv, "openai", STORED_OPENAI)).toBe("unchecked");
    services(() => Response.json({ error: { message: "Incorrect API key" } }, { status: 401 }));
    expect(await checkModelKey(env as GatewayEnv, "openai", STORED_OPENAI)).toBe("refused");
  });

  it("is unreachable when the call fails, and logs neither the key nor the call", async () => {
    const logged = captureLogs();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError(`refused ${STORED_OPENAI}`));
    expect(await checkModelKey(env as GatewayEnv, "openai", STORED_OPENAI)).toBe("unreachable");
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(STORED_OPENAI);
  });

  it("refuses what isn't a slot or a key without calling anything", async () => {
    const seen = services(() => Response.json({}));
    for (const [name, value] of [
      ["claude-code", STORED_ANTHROPIC],
      ["anthropic", "short"],
      ["anthropic", `${STORED_ANTHROPIC} x`],
    ] as const) {
      expect(await exports.ProviderCheck.check(name as "anthropic", value)).toBe("invalid_input");
    }
    expect(seen).toEqual([]);
  });

  describe("AI Gateway's token", () => {
    const verify = (status: string) => Response.json({ success: true, result: { status } });
    const refused = () => Response.json({ success: false }, { status: 401 });

    it("is accepted when Cloudflare says a user token is active", async () => {
      const seen = services(() => verify("active"));
      expect(await checkModelKey(env as GatewayEnv, "ai-gateway", STORED_GATEWAY)).toBe("accepted");
      expect(seen.map((one) => [one.url, one.headers.get("authorization")])).toEqual([
        ["https://api.cloudflare.com/client/v4/user/tokens/verify", `Bearer ${STORED_GATEWAY}`],
      ]);
    });

    it("is checked as an account's token, with the account in a gateway's URL", async () => {
      const seen = services((url) =>
        url.pathname.startsWith("/client/v4/accounts/") ? verify("active") : refused(),
      );
      const keyed = { ...(env as GatewayEnv), ANTHROPIC_BASE_URL: `${GATEWAY_URL}/anthropic` };
      expect(await checkModelKey(keyed, "ai-gateway", STORED_GATEWAY)).toBe("accepted");
      expect(seen.map((one) => one.url)).toEqual([
        "https://api.cloudflare.com/client/v4/user/tokens/verify",
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`,
      ]);
    });

    it("is refused when neither check finds it active", async () => {
      services((url) => (url.pathname.includes("/accounts/") ? verify("disabled") : refused()));
      const keyed = { ...(env as GatewayEnv), OPENAI_BASE_URL: `${GATEWAY_URL}/openai` };
      expect(await checkModelKey(keyed, "ai-gateway", STORED_GATEWAY)).toBe("refused");
      expect(await checkModelKey(env as GatewayEnv, "ai-gateway", STORED_GATEWAY)).toBe("refused");
    });

    it("is stored unchecked when it is an account's token and no gateway names the account", async () => {
      services(() => refused());
      expect(await checkModelKey(env as GatewayEnv, "ai-gateway", `cfat_${"a".repeat(40)}`)).toBe(
        "unchecked",
      );
    });

    it("is unreachable when Cloudflare can't answer", async () => {
      services(() => new Response(null, { status: 503 }));
      expect(await checkModelKey(env as GatewayEnv, "ai-gateway", STORED_GATEWAY)).toBe(
        "unreachable",
      );
    });
  });
});
