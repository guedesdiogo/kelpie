import { DurableObject } from "cloudflare:workers";
import type { ModelSettings, ProviderId } from "@kelpie/llm";

/** Who changed the instance's settings, for the audit: the user and the path they came by. */
export interface DefaultsActor {
  userId: string;
  via: string;
}

/**
 * What every call starts from: the instance's model settings, its pinned provider, and whether the
 * owner turned the `claude-code` route on (#295), which is off until they do.
 */
export interface InstanceDefaults {
  instance: ModelSettings;
  pinned: ProviderId | null;
  claudeCode: boolean;
}

/**
 * The instance's model settings, its pinned provider and its `claude-code` switch (ADR-0036 §2,
 * #286, #295), one object per instance. It holds small values in its key-value storage, so it has
 * no SQL migrations: the settings, the pin, the switch, and one `audit:` entry per change (#289).
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
    return {
      instance: kv.get<ModelSettings>("instance") ?? {},
      pinned,
      claudeCode: kv.get<boolean>("claudeCode") === true,
    };
  }

  /** The instance's settings, pin and switch as they stand, pinning nothing. */
  view(): InstanceDefaults {
    const kv = this.ctx.storage.kv;
    return {
      instance: kv.get<ModelSettings>("instance") ?? {},
      pinned: kv.get<ProviderId>("pinnedProvider") ?? null,
      claudeCode: kv.get<boolean>("claudeCode") === true,
    };
  }

  /** Replaces the instance's settings, already validated by llm-gateway, audited with its actor. */
  configure(settings: ModelSettings, actor: DefaultsActor): void {
    this.ctx.storage.kv.put("instance", settings);
    this.#audit(actor, { settings });
  }

  /**
   * Turns the `claude-code` route on or off for the instance (#295), audited with its actor like a
   * change of settings. Off is the default, and what a missing value means.
   */
  setClaudeCode(on: boolean, actor: DefaultsActor): void {
    this.ctx.storage.kv.put("claudeCode", on);
    this.#audit(actor, { claudeCode: on });
  }

  /** For the deploy's probe (#234): answers once the object runs, and changes nothing. */
  ping(): { ok: true } {
    return { ok: true };
  }

  /** One `audit:` entry for a change and its actor. Keys sort by time, so the audit lists in order. */
  #audit(
    actor: DefaultsActor,
    change: { settings: ModelSettings } | { claudeCode: boolean },
  ): void {
    const kv = this.ctx.storage.kv;
    const at = Date.now();
    const seq = (kv.get<number>("auditSeq") ?? 0) + 1;
    kv.put("auditSeq", seq);
    kv.put(`audit:${String(at).padStart(15, "0")}:${String(seq).padStart(6, "0")}`, {
      at,
      userId: actor.userId,
      via: actor.via,
      ...change,
    });
  }
}
