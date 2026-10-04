import { DurableObject } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import type { Admission, ChannelIdentity, IdentityStatus } from "../access.ts";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/**
 * Outcomes of a configuration change. Refusals are values, not exceptions: the configuration
 * commands turn them into answers for the owner.
 */
export type OwnerResult = { ok: true } | { ok: false; reason: "owner_exists" };
export type IdentityResult =
  | { ok: true; status: IdentityStatus }
  | { ok: false; reason: "no_owner" | "unknown_identity" };

/**
 * Who may reach the agents (ADR-0004). `ingress` asks it before anything else wakes. It is
 * strongly consistent, so disabling an identity applies to the next message.
 *
 * Phase 1 is single-player (ADR-0015): it holds the owner and the owner's channel identities, and
 * is their source of truth. Kelpie runs one instance, named "directory".
 */
export class Directory extends DurableObject<Env> {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    // If a migration fails, the object resets and the next request retries it.
    void ctx.blockConcurrencyWhile(() => migrate(this.#db, migrations));
  }

  /** Registers the owner. Repeating it with the same id is a no-op; a second owner is refused. */
  registerOwner(userId: string): OwnerResult {
    const owner = this.#owner();
    if (owner)
      return owner.userId === userId ? { ok: true } : { ok: false, reason: "owner_exists" };
    this.#db.transaction((tx) => {
      tx.insert(schema.users).values({ userId, role: "owner", createdAt: new Date() }).run();
      tx.insert(schema.auditLog)
        .values({ at: new Date(), action: "owner.registered", userId })
        .run();
    });
    return { ok: true };
  }

  /** Adds one of the owner's identities as pending; pairing enables it. Returns its status. */
  addIdentity(identity: ChannelIdentity): IdentityResult {
    const owner = this.#owner();
    if (!owner) return { ok: false, reason: "no_owner" };
    const existing = this.#identity(identity);
    if (existing) return { ok: true, status: existing.status };
    this.#db.transaction((tx) => {
      tx.insert(schema.identities)
        .values({ ...identity, userId: owner.userId, status: "pending", updatedAt: new Date() })
        .run();
      tx.insert(schema.auditLog)
        .values({
          at: new Date(),
          action: "identity.added",
          userId: owner.userId,
          channel: identity.channel,
        })
        .run();
    });
    return { ok: true, status: "pending" };
  }

  enableIdentity(identity: ChannelIdentity): IdentityResult {
    return this.#setStatus(identity, "enabled");
  }

  disableIdentity(identity: ChannelIdentity): IdentityResult {
    return this.#setStatus(identity, "disabled");
  }

  listIdentities(): (ChannelIdentity & { status: IdentityStatus })[] {
    return this.#db
      .select({
        channel: schema.identities.channel,
        channelUserId: schema.identities.channelUserId,
        status: schema.identities.status,
      })
      .from(schema.identities)
      .all() as (ChannelIdentity & { status: IdentityStatus })[];
  }

  /**
   * Decides whether a sender may reach an agent. The owner reaches every agent. Other roles don't
   * exist in phase 1; when they arrive they'll need a grant for `agentId` (ADR-0015).
   */
  admit(identity: ChannelIdentity, _agentId: string): Admission {
    const user = this.#db
      .select({ userId: schema.users.userId, role: schema.users.role })
      .from(schema.identities)
      .innerJoin(schema.users, eq(schema.users.userId, schema.identities.userId))
      .where(
        and(
          eq(schema.identities.channel, identity.channel),
          eq(schema.identities.channelUserId, identity.channelUserId),
          eq(schema.identities.status, "enabled"),
        ),
      )
      .get();
    if (!user) return { admitted: false, reason: "unknown_identity" };
    if (user.role !== "owner") return { admitted: false, reason: "no_grant" };
    return { admitted: true, userId: user.userId, role: user.role };
  }

  #owner() {
    return this.#db
      .select({ userId: schema.users.userId })
      .from(schema.users)
      .where(eq(schema.users.role, "owner"))
      .get();
  }

  #identity(identity: ChannelIdentity) {
    return this.#db
      .select({ userId: schema.identities.userId, status: schema.identities.status })
      .from(schema.identities)
      .where(
        and(
          eq(schema.identities.channel, identity.channel),
          eq(schema.identities.channelUserId, identity.channelUserId),
        ),
      )
      .get();
  }

  #setStatus(identity: ChannelIdentity, status: "enabled" | "disabled"): IdentityResult {
    const existing = this.#identity(identity);
    if (!existing) return { ok: false, reason: "unknown_identity" };
    if (existing.status === status) return { ok: true, status };
    this.#db.transaction((tx) => {
      tx.update(schema.identities)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            eq(schema.identities.channel, identity.channel),
            eq(schema.identities.channelUserId, identity.channelUserId),
          ),
        )
        .run();
      tx.insert(schema.auditLog)
        .values({
          at: new Date(),
          action: `identity.${status}`,
          userId: existing.userId,
          channel: identity.channel,
        })
        .run();
    });
    return { ok: true, status };
  }
}
