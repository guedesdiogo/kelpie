import { DurableObject } from "cloudflare:workers";
import type { ModelSettings, ProviderId } from "@kelpie/llm";

/** Who changed the instance's settings, for the audit: the user and the path they came by. */
export interface DefaultsActor {
  userId: string;
  via: string;
}

/** What every call starts from: the instance's model settings and its pinned provider. */
export interface InstanceDefaults {
  instance: ModelSettings;
  pinned: ProviderId | null;
}

/**
 * The instance's model settings and its pinned provider (ADR-0036 §2, #286), one object per
 * instance. It holds small values in its key-value storage, so it has no SQL migrations: the
 * settings, the pin, and one `audit:` entry per change (#289).
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

  /** The instance's settings and pin as they stand, pinning nothing. */
  view(): InstanceDefaults {
    const kv = this.ctx.storage.kv;
    return {
      instance: kv.get<ModelSettings>("instance") ?? {},
      pinned: kv.get<ProviderId>("pinnedProvider") ?? null,
    };
  }

  /**
   * Replaces the instance's settings, already validated by llm-gateway, and audits the change with
   * its actor. Keys sort by time, so the audit lists in order.
   */
  configure(settings: ModelSettings, actor: DefaultsActor): void {
    const kv = this.ctx.storage.kv;
    const at = Date.now();
    const seq = (kv.get<number>("auditSeq") ?? 0) + 1;
    kv.put("instance", settings);
    kv.put("auditSeq", seq);
    kv.put(`audit:${String(at).padStart(15, "0")}:${String(seq).padStart(6, "0")}`, {
      at,
      userId: actor.userId,
      via: actor.via,
      settings,
    });
  }

  /** For the deploy's probe (#234): answers once the object runs, and changes nothing. */
  ping(): { ok: true } {
    return { ok: true };
  }
}
