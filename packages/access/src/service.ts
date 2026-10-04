import { and, asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ChannelIdentity, DirectoryEntry, DirectoryPort, Role } from "./directory.ts";
import * as schema from "./schema.ts";

export type AccessDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AccessDb["transaction"]>[0]>[0];

export class AccessError extends Error {
  override readonly name = "AccessError";

  constructor(
    message: string,
    readonly code: "not_found",
  ) {
    super(message);
  }
}

/** Who asked for a change. `null` is Kelpie itself, such as the first-run bootstrap. */
export interface Actor {
  userId: string | null;
}

/**
 * Changes who may reach which agent, in Postgres, and keeps the `Directory` in step.
 *
 * The `Directory` may only lag Postgres in the restrictive direction:
 * - a restriction (revoking, disabling, deleting) is pushed before the transaction commits. If the
 *   push fails nothing changes; if the commit fails, the `Directory` is only stricter than Postgres;
 * - a permission is pushed after the commit. If that push fails, the user isn't admitted yet, and
 *   `resyncUser` delivers it.
 *
 * Pushes carry the user's complete state and a version from the `access_version` sequence, taken
 * while the user's row is locked, so the `Directory` can apply them in order and ignore stale ones.
 * The state is read in the transaction that wrote it. Give this service the cache-disabled
 * Hyperdrive binding anyway: Hyperdrive's query cache isn't invalidated by writes (ADR-0007).
 */
export class AccessService {
  readonly #db: AccessDb;
  readonly #directory: DirectoryPort;

  constructor(db: AccessDb, directory: DirectoryPort) {
    this.#db = db;
    this.#directory = directory;
  }

  async createUser(actor: Actor, input: { displayName: string; role: Role }): Promise<string> {
    return this.#db.transaction(async (tx) => {
      const { id } = first(
        await tx.insert(schema.users).values(input).returning({ id: schema.users.id }),
      );
      await audit(tx, actor, "user.created", id, { role: input.role });
      return id;
    });
  }

  async registerAgent(actor: Actor, agent: { id: string; name: string }): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.insert(schema.agents).values(agent);
      await audit(tx, actor, "agent.registered", null, { agentId: agent.id });
    });
  }

  /** Adds an identity in the pending state. Pairing enables it. */
  async addIdentity(actor: Actor, userId: string, identity: ChannelIdentity): Promise<string> {
    return this.#db.transaction(async (tx) => {
      const { id } = first(
        await tx
          .insert(schema.channelIdentities)
          .values({ userId, ...identity })
          .returning({ id: schema.channelIdentities.id }),
      );
      await audit(tx, actor, "identity.added", userId, {
        identityId: id,
        channel: identity.channel,
      });
      return id;
    });
  }

  async enableIdentity(actor: Actor, identityId: string): Promise<void> {
    await this.#setIdentityStatus(actor, identityId, "enabled", "permit");
  }

  async disableIdentity(actor: Actor, identityId: string): Promise<void> {
    await this.#setIdentityStatus(actor, identityId, "disabled", "restrict");
  }

  async grantAgent(actor: Actor, userId: string, agentId: string): Promise<void> {
    await this.#change(userId, "permit", async (tx) => {
      await tx.insert(schema.grants).values({ userId, agentId }).onConflictDoNothing();
      await audit(tx, actor, "grant.added", userId, { agentId });
    });
  }

  async revokeAgent(actor: Actor, userId: string, agentId: string): Promise<void> {
    await this.#change(userId, "restrict", async (tx) => {
      await tx
        .delete(schema.grants)
        .where(and(eq(schema.grants.userId, userId), eq(schema.grants.agentId, agentId)));
      await audit(tx, actor, "grant.revoked", userId, { agentId });
    });
  }

  /** Deletes the user with their identities and grants. The audit log keeps only their id. */
  async deleteUser(actor: Actor, userId: string): Promise<void> {
    await this.#change(userId, "restrict", async (tx) => {
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
      await audit(tx, actor, "user.deleted", userId, {});
    });
  }

  /** Pushes the user's current state again, after a push that failed. */
  async resyncUser(userId: string): Promise<void> {
    await this.#change(userId, "permit", async () => {});
  }

  async #setIdentityStatus(
    actor: Actor,
    identityId: string,
    status: "enabled" | "disabled",
    effect: "permit" | "restrict",
  ): Promise<void> {
    // An identity never changes owner, so reading its user outside the transaction is safe.
    const identity = await this.#db
      .select({ userId: schema.channelIdentities.userId })
      .from(schema.channelIdentities)
      .where(eq(schema.channelIdentities.id, identityId));
    const { userId } = first(identity, `No identity ${identityId}`);
    await this.#change(userId, effect, async (tx) => {
      await tx
        .update(schema.channelIdentities)
        .set({ status })
        .where(eq(schema.channelIdentities.id, identityId));
      await audit(tx, actor, `identity.${status}`, userId, { identityId });
    });
  }

  async #change(
    userId: string,
    effect: "permit" | "restrict",
    apply: (tx: Tx) => Promise<void>,
  ): Promise<void> {
    const entry = await this.#db.transaction(async (tx) => {
      // Taking the version locks the user's row, so one user's changes get versions in commit order.
      const { version } = first(
        await tx
          .update(schema.users)
          .set({ version: sql`nextval('access_version')` })
          .where(eq(schema.users.id, userId))
          .returning({ version: schema.users.version }),
        `No user ${userId}`,
      );
      await apply(tx);
      const entry = await readEntry(tx, userId, version);
      if (effect === "restrict") await this.#directory.putUser(entry);
      return entry;
    });
    if (effect === "permit") await this.#directory.putUser(entry);
  }
}

async function readEntry(tx: Tx, userId: string, version: number): Promise<DirectoryEntry> {
  const [user] = await tx
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user) return { userId, version, deleted: true };
  const identities = await tx
    .select({
      channel: schema.channelIdentities.channel,
      channelUserId: schema.channelIdentities.channelUserId,
    })
    .from(schema.channelIdentities)
    .where(
      and(
        eq(schema.channelIdentities.userId, userId),
        eq(schema.channelIdentities.status, "enabled"),
      ),
    )
    .orderBy(asc(schema.channelIdentities.channel), asc(schema.channelIdentities.channelUserId));
  const grants = await tx
    .select({ agentId: schema.grants.agentId })
    .from(schema.grants)
    .where(eq(schema.grants.userId, userId))
    .orderBy(asc(schema.grants.agentId));
  return {
    userId,
    version,
    deleted: false,
    role: user.role,
    identities: identities as ChannelIdentity[],
    agentIds: grants.map((grant) => grant.agentId),
  };
}

async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  targetUserId: string | null,
  details: Record<string, string>,
): Promise<void> {
  await tx
    .insert(schema.auditLog)
    .values({ actorUserId: actor.userId, action, targetUserId, details });
}

function first<T>(rows: T[], message = "The query returned no row"): T {
  const [row] = rows;
  if (row === undefined) throw new AccessError(message, "not_found");
  return row;
}
