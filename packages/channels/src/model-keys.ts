// The model keys the owner sets through a one-time form that expires (ADR-0068): each goes into its
// slot of the secret store, `provider:<name>`, and llm-gateway alone reads them, through
// channel-egress's `ProviderKeys` entrypoint. A key never crosses any other entrypoint.

/**
 * Each key's slot name: the providers' API keys, the token of an authenticated AI Gateway
 * (`AI_GATEWAY_TOKEN`), and Jev's key on TypeSafe (`TYPESAFE_API_KEY`, ADR-0018).
 */
export const MODEL_KEYS = ["anthropic", "openai", "ai-gateway", "typesafe"] as const;

export type ModelKey = (typeof MODEL_KEYS)[number];

export const isModelKey = (value: unknown): value is ModelKey =>
  typeof value === "string" && (MODEL_KEYS as readonly string[]).includes(value);

/** A key as a form takes it: printable, without spaces, 16 to 512 characters. */
const MODEL_KEY_VALUE = /^[\x21-\x7e]{16,512}$/;

export const isModelKeyValue = (value: unknown): value is string =>
  typeof value === "string" && MODEL_KEY_VALUE.test(value);

/** The keys stored through forms, by slot; a slot with none is left out. */
export type StoredModelKeys = Partial<Record<ModelKey, string>>;

/** `ProviderKeys.keys()`: the stored keys only, never a Worker secret. */
export type ProviderKeysOutcome =
  | { ok: true; keys: StoredModelKeys }
  | { ok: false; reason: "store_unavailable" };

/**
 * What llm-gateway binds on channel-egress to read the stored model keys (ADR-0068 §3): no other
 * Worker binds it, and it returns `provider:` slots only.
 */
export interface ProviderKeysContract {
  keys(): Promise<ProviderKeysOutcome>;
}

/**
 * The keys in a `ProviderKeys` answer, rebuilt from the known slots whose value is a key, or null
 * for an answer that has none to give, so the caller falls back.
 */
export function storedModelKeysOf(answer: unknown): StoredModelKeys | null {
  const { ok, keys } = (answer ?? {}) as { ok?: unknown; keys?: unknown };
  if (ok !== true || typeof keys !== "object" || keys === null || Array.isArray(keys)) return null;
  const stored: StoredModelKeys = {};
  for (const name of MODEL_KEYS) {
    const value = (keys as Record<string, unknown>)[name];
    if (isModelKeyValue(value)) stored[name] = value;
  }
  return stored;
}

/**
 * How a key's check went (ADR-0068 §2): its service accepted or refused it, has no cheap read to
 * check it with (`unchecked`, stored anyway, and the form's page says so), or couldn't be reached
 * (`unreachable`: the form stays open, and the try doesn't count).
 */
export type ModelKeyCheck = "accepted" | "refused" | "unchecked" | "unreachable";

/**
 * What checks a candidate key with a cheap authenticated read on its service, such as listing the
 * provider's models (ADR-0068 §2): llm-gateway makes the call and keeps nothing.
 */
export interface ProviderCheckContract {
  check(name: ModelKey, value: string): Promise<ModelKeyCheck | "invalid_input">;
}

/** Where the key a slot serves with comes from (ADR-0068 §4): a form, the deploy, or nowhere. */
export type ModelKeySource = "form" | "deploy" | "none";
