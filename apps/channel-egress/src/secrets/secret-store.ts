import { DurableObject } from "cloudflare:workers";
import { and, eq, gt, lte } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { importSecretsKey, open, randomToken, seal, sha256 } from "./crypto.ts";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/** Kelpie runs one SecretStore. */
export const SECRET_STORE_NAME = "secrets";

/** A secure-form link works for this long, and once. */
const FORM_LIFETIME_MS = 15 * 60_000;

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

  /** What a form is for, while it is still open. */
  async describeForm(token: string): Promise<{ agentId: string; kind: FormKind } | null> {
    const tokenHash = await sha256(token);
    const form = this.#db
      .select({ agentId: schema.forms.agentId, kind: schema.forms.kind })
      .from(schema.forms)
      .where(and(eq(schema.forms.tokenHash, tokenHash), gt(schema.forms.expiresAt, Date.now())))
      .get();
    return form ?? null;
  }

  /**
   * Closes a form and stores its value, encrypted, in the form's slot. The form is claimed before
   * anything is awaited, so two submissions of one link can't both store.
   */
  async redeemForm(
    token: string,
    value: string,
  ): Promise<
    { ok: true; agentId: string } | { ok: false; reason: "unknown_form" | "store_unavailable" }
  > {
    const key = await this.#loadKey();
    if (!key) return { ok: false, reason: "store_unavailable" };
    const tokenHash = await sha256(token);
    const form = this.#db
      .delete(schema.forms)
      .where(and(eq(schema.forms.tokenHash, tokenHash), gt(schema.forms.expiresAt, Date.now())))
      .returning()
      .get();
    if (!form) return { ok: false, reason: "unknown_form" };
    const slot = slotFor(form.kind, form.agentId);
    const sealed = await seal(key, slot, value);
    const updatedAt = Date.now();
    this.#db
      .insert(schema.secrets)
      .values({ slot, ...sealed, updatedAt })
      .onConflictDoUpdate({ target: schema.secrets.slot, set: { ...sealed, updatedAt } })
      .run();
    return { ok: true, agentId: form.agentId };
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

  /** A missing or malformed key leaves the store closed: nothing is read or written. */
  #loadKey(): Promise<CryptoKey | null> {
    this.#key ??= importSecretsKey(this.env.SECRETS_KEY).catch(() => {
      console.error("SecretStore: SECRETS_KEY is missing or isn't 32 bytes of base64");
      return null;
    });
    return this.#key;
  }
}

function slotFor(kind: FormKind, agentId: string): string {
  return `${kind}:${agentId}`;
}
