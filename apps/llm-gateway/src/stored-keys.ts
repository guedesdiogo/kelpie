import {
  MODEL_KEYS,
  type ModelKey,
  type ModelKeySource,
  type ProviderKeysContract,
  type StoredModelKeys,
  storedModelKeysOf,
} from "@kelpie/channels";

// The model keys the owner set through a one-time form (ADR-0068), which channel-egress's
// `ProviderKeys` returns to this Worker alone. A stored key takes its Worker secret's place; the
// Worker secret serves while none is stored, and when the store can't answer.

/** A read older than this is read again by the next call that needs a key. */
export const KEYS_FRESH_MS = 30_000;
/**
 * A key read is used for this long at most (ADR-0068 §3), so a rotation or a removal applies
 * within a minute. Past it, while the store can't answer, the Worker secrets serve.
 */
export const KEYS_KEPT_MS = 60_000;
/** A read that takes longer counts as failed: a model call never waits on the store for long. */
const READ_TIMEOUT_MS = 2_000;

/** Each slot's Worker secret, which the owner sets with `wrangler secret put` (ADR-0019). */
export const KEY_SECRETS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "ai-gateway": "AI_GATEWAY_TOKEN",
  typesafe: "TYPESAFE_API_KEY",
} as const satisfies Record<ModelKey, string>;

type KeySecrets = { [Name in ModelKey as (typeof KEY_SECRETS)[Name]]?: string };

/** What the keys need from the Worker's env: its secrets, and the binding to `ProviderKeys`. */
export type KeyedEnv = KeySecrets & { PROVIDER_KEYS: unknown };

/** The isolate's last read: the keys, when they were read, and when a read was last tried. */
let held: { keys: StoredModelKeys; readAt: number; triedAt: number } | undefined;
/** The read under way, which every call that needs it shares. */
let reading: Promise<void> | undefined;

/**
 * `env` with each stored key in its Worker secret's place, and where each slot's key comes from.
 * `now` is the caller's clock.
 */
export async function withStoredKeys<E extends KeyedEnv>(
  env: E,
  now = Date.now(),
): Promise<{ env: E; sources: Record<ModelKey, ModelKeySource> }> {
  const stored = await storedKeys(env.PROVIDER_KEYS as ProviderKeysContract, now);
  const keyed: E = { ...env };
  const sources = {} as Record<ModelKey, ModelKeySource>;
  for (const name of MODEL_KEYS) {
    const secret = KEY_SECRETS[name];
    const value = stored[name];
    if (value) (keyed as KeySecrets)[secret] = value;
    sources[name] = value ? "form" : env[secret] ? "deploy" : "none";
  }
  return { env: keyed, sources };
}

/**
 * The stored keys: the last read while it is under KEYS_FRESH_MS old, else a new one. When the
 * store can't answer, the last read while it is under KEYS_KEPT_MS old, else none.
 */
async function storedKeys(binding: ProviderKeysContract, now: number): Promise<StoredModelKeys> {
  if (!held || now - held.triedAt >= KEYS_FRESH_MS) {
    reading ??= read(binding, now).finally(() => {
      reading = undefined;
    });
    await reading;
  }
  if (held && now - held.readAt < KEYS_KEPT_MS) return held.keys;
  // Past its time, a key isn't kept for later either.
  if (held) held = { ...held, keys: {} };
  return {};
}

async function read(binding: ProviderKeysContract, now: number): Promise<void> {
  let keys: StoredModelKeys | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      binding.keys(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), READ_TIMEOUT_MS);
      }),
    ]);
    keys = storedModelKeysOf(answer);
    if (!keys) console.error("llm-gateway: the stored model keys couldn't be read", "no_answer");
  } catch (error) {
    // By its name only: a message could quote what the store holds.
    const name = error instanceof Error ? error.name : "unknown";
    console.error("llm-gateway: the stored model keys couldn't be read", name);
  } finally {
    clearTimeout(timer);
  }
  held = keys
    ? { keys, readAt: now, triedAt: now }
    : { keys: held?.keys ?? {}, readAt: held?.readAt ?? Number.NEGATIVE_INFINITY, triedAt: now };
}

/** Forgets the isolate's last read, so each test starts with none. Production never calls it. */
export function forgetStoredKeysForTesting(): void {
  held = undefined;
  reading = undefined;
}
