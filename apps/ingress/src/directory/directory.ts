import { DurableObject } from "cloudflare:workers";
import {
  type Admission,
  CHANNEL_IDS,
  type ChannelIdentity,
  type IdentityResult,
  type IdentityStatus,
  type OwnerResult,
} from "@kelpie/access";
import { and, eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/**
 * Who may reach the agents (ADR-0004). Channel routes ask it before any conversation or model runs.
 * It is strongly consistent, so disabling an identity applies to the next message.
 *
 * Until multi-user lands (ADR-0015) it holds the owner and the owner's channel identities, and is
 * their source of truth. Kelpie runs one instance, named "directory". Only `ingress` binds it: the
 * methods trust their caller, so no route may proxy them.
 */
export class Directory extends DurableObject<Env> {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    // If a migration fails the object resets, and the next request retries it.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#db, migrations);
      } catch (error) {
        console.error("Directory migration failed", error);
        throw error;
      }
    });
  }

  /** Registers the owner. Repeating it with the same id is a no-op; a second owner is refused. */
  registerOwner(userId: string): OwnerResult {
    if (!isNonEmpty(userId)) return { ok: false, reason: "invalid_user" };
    const owner = this.#db
      .select({ userId: schema.users.userId })
      .from(schema.users)
      .where(eq(schema.users.role, "owner"))
      .get();
    if (owner) {
      return owner.userId === userId ? { ok: true } : { ok: false, reason: "owner_exists" };
    }
    this.#db.transaction((tx) => {
      tx.insert(schema.users).values({ userId, role: "owner", createdAt: new Date() }).run();
      tx.insert(schema.auditLog)
        .values({ at: new Date(), action: "owner.registered", userId })
        .run();
    });
    return { ok: true };
  }

  /** Adds an identity to a user as pending; pairing enables it. Returns its status. */
  addIdentity(userId: string, identity: ChannelIdentity): IdentityResult {
    if (!isValidIdentity(identity)) return { ok: false, reason: "invalid_identity" };
    const user = this.#db
      .select({ userId: schema.users.userId })
      .from(schema.users)
      .where(eq(schema.users.userId, userId))
      .get();
    if (!user) return { ok: false, reason: "unknown_user" };
    const existing = this.#identity(identity);
    if (existing) {
      return existing.userId === userId
        ? { ok: true, status: existing.status }
        : { ok: false, reason: "identity_taken" };
    }
    this.#db.transaction((tx) => {
      tx.insert(schema.identities)
        .values({ ...identity, userId, status: "pending", updatedAt: new Date() })
        .run();
      tx.insert(schema.auditLog)
        .values({ at: new Date(), action: "identity.added", userId, channel: identity.channel })
        .run();
    });
    return { ok: true, status: "pending" };
  }

  /**
   * Enables an identity. This is the allowlist itself, so callers must hold proof: a completed
   * pairing for a pending identity (the channel and bootstrap stories), or an owner-authenticated
   * command to re-enable a disabled one (Story 3.10). Nothing here checks that proof.
   */
  enableIdentity(identity: ChannelIdentity): IdentityResult {
    return this.#setStatus(identity, "enabled");
  }

  disableIdentity(identity: ChannelIdentity): IdentityResult {
    return this.#setStatus(identity, "disabled");
  }

  /** Every identity with its status. The values are personal data: mask them in any output. */
  listIdentities(): (ChannelIdentity & { status: IdentityStatus })[] {
    return this.#db
      .select({
        channel: schema.identities.channel,
        channelUserId: schema.identities.channelUserId,
        status: schema.identities.status,
      })
      .from(schema.identities)
      .all();
  }

  /**
   * Decides whether a sender may reach an agent. The owner reaches every agent. Other roles don't
   * exist until multi-user lands; then they'll need a grant for `agentId` (ADR-0015).
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

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// RPC callers aren't type-checked, so identities are checked where they enter storage.
function isValidIdentity(identity: ChannelIdentity): boolean {
  return CHANNEL_IDS.includes(identity?.channel) && isNonEmpty(identity?.channelUserId);
}
