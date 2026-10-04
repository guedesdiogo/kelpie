import { DurableObject } from "cloudflare:workers";
import type { Admission, ChannelIdentity, DirectoryEntry } from "@kelpie/access";
import { and, eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/**
 * The hot-path copy of who may reach which agent (ADR-0004). `ingress` asks it before anything
 * else wakes; the access service pushes every change. It is strongly consistent, so a revocation
 * applies to the next message. Kelpie runs a single instance, named "directory".
 */
export class Directory extends DurableObject<Env> {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    void ctx.blockConcurrencyWhile(() => migrate(this.#db, migrations));
  }

  /** Replaces a user's access state, unless a newer version is already applied. */
  putUser(entry: DirectoryEntry): { applied: boolean } {
    const current = this.#db
      .select({ version: schema.users.version })
      .from(schema.users)
      .where(eq(schema.users.userId, entry.userId))
      .get();
    if (current && current.version >= entry.version) return { applied: false };

    this.#db.transaction((tx) => {
      const row = {
        version: entry.version,
        role: entry.deleted ? null : entry.role,
        deleted: entry.deleted,
      };
      tx.insert(schema.users)
        .values({ userId: entry.userId, ...row })
        .onConflictDoUpdate({ target: schema.users.userId, set: row })
        .run();
      tx.delete(schema.identities).where(eq(schema.identities.userId, entry.userId)).run();
      tx.delete(schema.grants).where(eq(schema.grants.userId, entry.userId)).run();
      if (entry.deleted) return;
      for (const identity of entry.identities) {
        // An identity moved to another user belongs to whichever push is applied last.
        tx.insert(schema.identities)
          .values({ ...identity, userId: entry.userId })
          .onConflictDoUpdate({
            target: [schema.identities.channel, schema.identities.channelUserId],
            set: { userId: entry.userId },
          })
          .run();
      }
      for (const agentId of entry.agentIds) {
        tx.insert(schema.grants).values({ userId: entry.userId, agentId }).run();
      }
    });
    return { applied: true };
  }

  /** Decides whether a sender may reach an agent. The owner reaches every agent. */
  admit(identity: ChannelIdentity, agentId: string): Admission {
    const user = this.#db
      .select({ userId: schema.users.userId, role: schema.users.role })
      .from(schema.identities)
      .innerJoin(schema.users, eq(schema.users.userId, schema.identities.userId))
      .where(
        and(
          eq(schema.identities.channel, identity.channel),
          eq(schema.identities.channelUserId, identity.channelUserId),
          eq(schema.users.deleted, false),
        ),
      )
      .get();
    if (!user?.role) return { admitted: false, reason: "unknown_identity" };
    if (user.role === "owner") return { admitted: true, userId: user.userId, role: user.role };

    const grant = this.#db
      .select({ agentId: schema.grants.agentId })
      .from(schema.grants)
      .where(and(eq(schema.grants.userId, user.userId), eq(schema.grants.agentId, agentId)))
      .get();
    return grant
      ? { admitted: true, userId: user.userId, role: user.role }
      : { admitted: false, reason: "no_grant" };
  }
}
