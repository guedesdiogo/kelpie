import { isModelKeyValue, MODEL_KEYS, type StoredModelKeys } from "@kelpie/channels";
import type { ReadResult, SecretStore } from "./secrets/secret-store.ts";

// The model keys' slots, `provider:<name>` (ADR-0068): the forms that fill them, and the only read
// that returns one, `ProviderKeys.keys()`, which llm-gateway alone binds.

/** How the key's form checked it: a double click is answered with the check, never the caller's. */
export type StoredCheck = "accepted" | "unchecked";

/** The stored value: the key and its check, as JSON, as the runner's slot keeps its secret. */
export const modelKeyValue = (key: string, check: StoredCheck): string =>
  JSON.stringify({ key, check });

/**
 * The key in a stored value, and its check, or null when it holds no key. A value with no check
 * reads as unchecked, which claims nothing.
 */
export function parseModelKey(value: string): { key: string; check: StoredCheck } | null {
  try {
    const { key, check } = (JSON.parse(value) ?? {}) as { key?: unknown; check?: unknown };
    if (!isModelKeyValue(key)) return null;
    return { key, check: check === "accepted" ? "accepted" : "unchecked" };
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
    const stored = parseModelKey(read.value);
    if (stored) keys[name] = stored.key;
    else console.error("channel-egress: a model key's slot holds no key");
  });
  return keys;
}
