import { DurableObject } from "cloudflare:workers";
import { and, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { importSecretsKey, open, randomToken, seal, sha256 } from "./crypto.ts";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/** Kelpie runs one SecretStore. */
export const SECRET_STORE_NAME = "secrets";

/** A secure-form link works for this long, and once. */
const FORM_LIFETIME_MS = 15 * 60_000;
/** A form closes after this many refused values. */
const MAX_REFUSALS = 5;
/** A used form is kept this long, so its own value sent again is answered with what it stored. */
const REDEEMED_GRACE_MS = 15 * 60_000;

export type FormKind = "telegram";

export type ReadResult =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "undecryptable" | "store_unavailable" };

/**
 * Kelpie's secret store (ADR-0013): values encrypted with AES-GCM under the SECRETS_KEY Worker
 * secret, and the one-time forms that fill them. Only channel-egress binds it, because `read`
 * returns plaintext: other Workers reach the forms through its `ChannelForms` entrypoint.
 */
export class SecretStore extends DurableObject<Env> {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;
  #key: Promise<CryptoKey | null> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#db, migrations);
      } catch (error) {
        console.error("SecretStore migration failed", error instanceof Error ? error.name : error);
        throw error;
      }
    });
  }

  /** Opens a one-time form for one secret of one agent. The token is only in the returned link. */
  async createForm(agentId: string, kind: FormKind): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken();
    const tokenHash = await sha256(token);
    const now = Date.now();
    this.#db.delete(schema.forms).where(lte(schema.forms.expiresAt, now)).run();
    const expiresAt = now + FORM_LIFETIME_MS;
    this.#db.insert(schema.forms).values({ tokenHash, agentId, kind, expiresAt }).run();
    return { token, expiresAt };
  }

  /** Whether the store can read and write: its key is present and well formed. */
  async ready(): Promise<boolean> {
    return (await this.#loadKey()) !== null;
  }

  /** What a form is for, while it is still open. */
  async describeForm(token: string): Promise<{ agentId: string; kind: FormKind } | null> {
    const form = await this.#openForm(token);
    return form ? { agentId: form.agentId, kind: form.kind } : null;
  }

  /**
   * What a form stored, when it was used in the last REDEEMED_GRACE_MS and its value is still the
   * one stored: a later form for the same slot ends what this one can answer for. A form's claim
   * and its value are written with one time stamp, which ties them.
   */
  async redeemedForm(token: string): Promise<{ agentId: string; kind: FormKind } | null> {
    if (!isFormToken(token)) return null;
    const tokenHash = await sha256(token);
    const form = this.#db
      .select()
      .from(schema.forms)
      .where(
        and(
          eq(schema.forms.tokenHash, tokenHash),
          isNotNull(schema.forms.redeemedAt),
          gt(schema.forms.expiresAt, Date.now()),
        ),
      )
      .get();
    if (!form?.redeemedAt) return null;
    const stored = this.#db
      .select({ updatedAt: schema.secrets.updatedAt })
      .from(schema.secrets)
      .where(eq(schema.secrets.slot, slotFor(form.kind, form.agentId)))
      .get();
    return stored?.updatedAt === form.redeemedAt
      ? { agentId: form.agentId, kind: form.kind }
      : null;
  }

  /** Counts a refused value; after a few the form closes. Returns whether it is still open. */
  async refuseValue(token: string): Promise<boolean> {
    const form = await this.#openForm(token);
    if (!form) return false;
    if (form.refusals + 1 >= MAX_REFUSALS) {
      this.#db.delete(schema.forms).where(eq(schema.forms.tokenHash, form.tokenHash)).run();
      return false;
    }
    this.#db
      .update(schema.forms)
      .set({ refusals: form.refusals + 1 })
      .where(eq(schema.forms.tokenHash, form.tokenHash))
      .run();
    return true;
  }

  /**
   * Closes a form and stores its value, encrypted, in the form's slot. The value is sealed first;
   * claiming the form and storing it then happen together, with nothing awaited between, so two
   * submissions of one link can't both store and a failure can't spend the form for nothing. The
   * used form is kept REDEEMED_GRACE_MS (`redeemedForm`).
   */
  async redeemForm(
    token: string,
    value: string,
  ): Promise<
    { ok: true; agentId: string } | { ok: false; reason: "unknown_form" | "store_unavailable" }
  > {
    const key = await this.#loadKey();
    if (!key) return { ok: false, reason: "store_unavailable" };
    const form = await this.#openForm(token);
    if (!form) return { ok: false, reason: "unknown_form" };
    const slot = slotFor(form.kind, form.agentId);
    const sealed = await seal(key, slot, value);
    const claimed = this.#db.transaction((tx) => {
      const updatedAt = Date.now();
      const still = tx
        .update(schema.forms)
        .set({ redeemedAt: updatedAt, expiresAt: updatedAt + REDEEMED_GRACE_MS })
        .where(
          and(
            eq(schema.forms.tokenHash, form.tokenHash),
            isNull(schema.forms.redeemedAt),
            gt(schema.forms.expiresAt, updatedAt),
          ),
        )
        .returning({ tokenHash: schema.forms.tokenHash })
        .get();
      if (!still) return false;
      tx.insert(schema.secrets)
        .values({ slot, ...sealed, updatedAt })
        .onConflictDoUpdate({ target: schema.secrets.slot, set: { ...sealed, updatedAt } })
        .run();
      return true;
    });
    return claimed ? { ok: true, agentId: form.agentId } : { ok: false, reason: "unknown_form" };
  }

  /** The plaintext of one slot. Only channel-egress calls this. */
  async read(kind: FormKind, agentId: string): Promise<ReadResult> {
    const key = await this.#loadKey();
    if (!key) return { ok: false, reason: "store_unavailable" };
    const slot = slotFor(kind, agentId);
    const row = this.#db.select().from(schema.secrets).where(eq(schema.secrets.slot, slot)).get();
    if (!row) return { ok: false, reason: "missing" };
    const value = await open(key, slot, row);
    return value === null ? { ok: false, reason: "undecryptable" } : { ok: true, value };
  }

  async #openForm(token: string) {
    if (!isFormToken(token)) return undefined;
    const tokenHash = await sha256(token);
    return this.#db
      .select()
      .from(schema.forms)
      .where(
        and(
          eq(schema.forms.tokenHash, tokenHash),
          isNull(schema.forms.redeemedAt),
          gt(schema.forms.expiresAt, Date.now()),
        ),
      )
      .get();
  }

  /**
   * A missing or malformed key leaves the store closed: nothing is read or written. A failed
   * import isn't kept, so a corrected secret is picked up.
   */
  async #loadKey(): Promise<CryptoKey | null> {
    this.#key ??= importSecretsKey(this.env.SECRETS_KEY).catch(() => {
      console.error("SecretStore: SECRETS_KEY is missing or isn't 32 bytes of base64");
      return null;
    });
    const key = await this.#key;
    if (!key) this.#key = undefined;
    return key;
  }
}

/** Form tokens are 32 random bytes in base64url: 43 characters. */
export function isFormToken(token: unknown): token is string {
  return typeof token === "string" && token.length <= 64 && /^[A-Za-z0-9_-]+$/.test(token);
}

function slotFor(kind: FormKind, agentId: string): string {
  return `${kind}:${agentId}`;
}
