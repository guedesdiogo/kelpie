import { isModelKeyValue, MODEL_KEYS, type StoredModelKeys } from "@kelpie/channels";
import type { ReadResult, SecretStore } from "./secrets/secret-store.ts";

// The model keys' slots, `provider:<name>` (ADR-0068): the forms that fill them, and the only read
// that returns one, `ProviderKeys.keys()`, which llm-gateway alone binds.

/** The stored value: the key, as JSON, so the slot can carry more later, as the runner's does. */
export const modelKeyValue = (key: string): string => JSON.stringify({ key });

/** The key in a stored value, or null when it isn't one. */
export function parseModelKey(value: string): string | null {
  try {
    const key = (JSON.parse(value) as { key?: unknown } | null)?.key;
    return isModelKeyValue(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * Every model key the store holds, by slot, or null when the store can't answer. A slot whose
 * value doesn't decrypt or isn't a key is left out, as one with none: llm-gateway then uses its
 * Worker secret. Never logs a value.
 */
export async function readModelKeys(
  store: Pick<SecretStore, "read">,
): Promise<StoredModelKeys | null> {
  const reads: ReadResult[] = await Promise.all(
    MODEL_KEYS.map((name) => store.read("provider", name)),
  );
  if (reads.some((read) => !read.ok && read.reason === "store_unavailable")) return null;
  const keys: StoredModelKeys = {};
  MODEL_KEYS.forEach((name, index) => {
    const read = reads[index];
    if (!read?.ok) {
      if (read?.reason === "undecryptable") console.error("channel-egress: model key unreadable");
      return;
    }
    const key = parseModelKey(read.value);
    if (key) keys[name] = key;
    else console.error("channel-egress: a model key's slot holds no key");
  });
  return keys;
}
