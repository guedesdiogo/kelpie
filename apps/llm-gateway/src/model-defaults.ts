import { DurableObject } from "cloudflare:workers";
import type { ModelSettings, ProviderId } from "@kelpie/llm";

/** What every call starts from: the instance's model settings and its pinned provider. */
export interface InstanceDefaults {
  instance: ModelSettings;
  pinned: ProviderId | null;
}

/**
 * The instance's model settings and its pinned provider (ADR-0036 §2, #286), one object per
 * instance. It holds two small values in its key-value storage, so it has no SQL migrations.
 * Story 5.5's tools write the settings; until then they are empty.
 */
export class ModelDefaults extends DurableObject {
  /**
   * The defaults a call resolves against. With nothing pinned yet, `withKey` (the first provider
   * with a key, in the cheap tier's order) is pinned, so a key added later doesn't move it.
   */
  defaults(withKey: ProviderId | null): InstanceDefaults {
    const kv = this.ctx.storage.kv;
    let pinned = kv.get<ProviderId>("pinnedProvider") ?? null;
    if (pinned === null && withKey !== null) {
      kv.put("pinnedProvider", withKey);
      pinned = withKey;
    }
    return { instance: kv.get<ModelSettings>("instance") ?? {}, pinned };
  }

  /** For the deploy's probe (#234): answers once the object runs, and changes nothing. */
  ping(): { ok: true } {
    return { ok: true };
  }
}
