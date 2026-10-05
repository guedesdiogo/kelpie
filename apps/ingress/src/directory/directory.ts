import { DurableObject } from "cloudflare:workers";
import {
  ACCESS_SOURCE,
  type Admission,
  CHANNEL_IDS,
  type ChannelIdentity,
  canonicalTimeZone,
  type DirectoryContract,
  type IdentityResult,
  type IdentityStatus,
  type OwnerResult,
  type PairingCodeResult,
  type PairingResult,
  type StrangerNotice,
  type TimeZoneResult,
} from "@kelpie/access";
import type { ChannelId } from "@kelpie/channels";
import { and, count, eq, gt, isNull, lt, or } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema.ts";

/** Hermes's pairing code rules (Story 3.6): no 0/O or 1/I to mistake. */
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_TTL_MS = 60 * 60_000;
/** A sender's wrong codes within this window count together; the fifth locks them for as long. */
const PAIRING_LOCK_MS = 60 * 60_000;
const MAX_PAIRING_FAILURES = 5;
/** Notices about strangers, per channel per day: a flood of new senders can't flood the owner. */
const STRANGER_NOTICES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60_000;
const NOTICED_SENDER_RETENTION_MS = 30 * DAY_MS;

/**
 * Who may reach the agents (ADR-0004). Channel routes ask it before any conversation or model runs.
 * It is strongly consistent, so disabling an identity applies to the next message.
 *
 * Until multi-user lands (ADR-0015) it holds the owner and the owner's identities, and is their
 * source of truth. Kelpie runs one instance, named "directory". Only `ingress` and `admin-api` bind
 * it: the methods trust their caller, so no route may proxy them.
 */
export class Directory extends DurableObject<Env> implements DirectoryContract {
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
    const owner = this.#owner();
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

  /**
   * A one-time code for `userId` to pair their account on `channel` (Story 3.6): the owner sends it
   * to the bot as `/start <code>`. Only its salted SHA-256 is kept. A new code replaces the last.
   */
  async issuePairingCode(userId: string, channel: ChannelId): Promise<PairingCodeResult> {
    if (!(CHANNEL_IDS as readonly string[]).includes(channel)) {
      return { ok: false, reason: "invalid_channel" };
    }
    if (!this.#user(userId)) return { ok: false, reason: "unknown_user" };
    const code = randomCode();
    const salt = randomHex(16);
    const hash = await sha256Hex(`${salt}${code}`);
    const now = Date.now();
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    this.#db.transaction((tx) => {
      tx.insert(schema.pairingCodes)
        .values({ userId, channel, salt, hash, expiresAt: new Date(expiresAt) })
        .onConflictDoUpdate({
          target: [schema.pairingCodes.userId, schema.pairingCodes.channel],
          set: { salt, hash, expiresAt: new Date(expiresAt) },
        })
        .run();
      tx.insert(schema.auditLog)
        .values({ at: new Date(now), action: "pairing.code_issued", userId, channel })
        .run();
    });
    return { ok: true, code, expiresAt };
  }

  /**
   * A `/start <code>` from a sender who isn't admitted. A match pairs the sender with the code's
   * user as enabled and spends the code. The sender's lock is checked before any code, so a valid
   * code doesn't get past it.
   */
  async redeemPairingCode(rawCode: string, identity: ChannelIdentity): Promise<PairingResult> {
    if (!isValidIdentity(identity)) return { ok: false, reason: "invalid_identity" };
    const now = Date.now();
    this.#db
      .delete(schema.pairingFailures)
      .where(
        and(
          lt(schema.pairingFailures.lastFailureAt, new Date(now - PAIRING_LOCK_MS)),
          or(
            isNull(schema.pairingFailures.lockedUntil),
            lt(schema.pairingFailures.lockedUntil, new Date(now)),
          ),
        ),
      )
      .run();
    const failures = this.#failures(identity);
    if (failures?.lockedUntil && failures.lockedUntil.getTime() > now) {
      return { ok: false, reason: "locked" };
    }
    const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "").toUpperCase() : "";
    const wellFormed =
      code.length === PAIRING_CODE_LENGTH &&
      [...code].every((character) => PAIRING_ALPHABET.includes(character));
    const candidates = wellFormed
      ? this.#db
          .select()
          .from(schema.pairingCodes)
          .where(
            and(
              eq(schema.pairingCodes.channel, identity.channel as ChannelId),
              gt(schema.pairingCodes.expiresAt, new Date(now)),
            ),
          )
          .all()
      : [];
    let match: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await sameHash(await sha256Hex(`${candidate.salt}${code}`), candidate.hash)) {
        match = candidate;
      }
    }
    if (!match) {
      this.#recordFailure(identity, now);
      return { ok: false, reason: "invalid_code" };
    }
    const existing = this.#identity(identity);
    if (existing && existing.userId !== match.userId) {
      return { ok: false, reason: "identity_taken" };
    }
    const pairedUser = match.userId;
    const spentHash = match.hash;
    // Hashing awaited, so another request may have spent or replaced the code since.
    const paired = this.#db.transaction((tx) => {
      const still = tx
        .select({ hash: schema.pairingCodes.hash })
        .from(schema.pairingCodes)
        .where(
          and(
            eq(schema.pairingCodes.userId, pairedUser),
            eq(schema.pairingCodes.channel, identity.channel as ChannelId),
            eq(schema.pairingCodes.hash, spentHash),
          ),
        )
        .get();
      if (!still) return false;
      tx.delete(schema.pairingCodes)
        .where(
          and(
            eq(schema.pairingCodes.userId, pairedUser),
            eq(schema.pairingCodes.channel, identity.channel as ChannelId),
          ),
        )
        .run();
      tx.delete(schema.pairingFailures).where(this.#failureKey(identity)).run();
      const at = new Date(now);
      if (!existing) {
        tx.insert(schema.identities)
          .values({ ...identity, userId: pairedUser, status: "enabled", updatedAt: at })
          .run();
      } else if (existing.status !== "enabled") {
        tx.update(schema.identities)
          .set({ status: "enabled", updatedAt: at })
          .where(this.#identityKey(identity))
          .run();
      }
      tx.insert(schema.auditLog)
        .values({ at, action: "identity.paired", userId: pairedUser, channel: identity.channel })
        .run();
      return true;
    });
    return paired ? { ok: true, userId: pairedUser } : { ok: false, reason: "invalid_code" };
  }

  /**
   * Whether to tell the owner about a stranger the channel route dropped: once per stranger, at
   * most ten a day per channel, and only once the owner has an account there to be told on.
   */
  noticeStranger(sender: ChannelIdentity): StrangerNotice {
    if (!isValidIdentity(sender)) return { notify: false };
    const now = Date.now();
    const channel = sender.channel as ChannelId;
    this.#db
      .delete(schema.noticedSenders)
      .where(lt(schema.noticedSenders.noticedAt, new Date(now - NOTICED_SENDER_RETENTION_MS)))
      .run();
    const owner = this.#db
      .select({ channelUserId: schema.identities.channelUserId })
      .from(schema.identities)
      .innerJoin(schema.users, eq(schema.users.userId, schema.identities.userId))
      .where(
        and(
          eq(schema.users.role, "owner"),
          eq(schema.identities.channel, channel),
          eq(schema.identities.status, "enabled"),
        ),
      )
      .get();
    if (!owner) return { notify: false };
    const seen = this.#db
      .select({ noticedAt: schema.noticedSenders.noticedAt })
      .from(schema.noticedSenders)
      .where(
        and(
          eq(schema.noticedSenders.channel, channel),
          eq(schema.noticedSenders.channelUserId, sender.channelUserId),
        ),
      )
      .get();
    if (seen) return { notify: false };
    const today =
      this.#db
        .select({ value: count() })
        .from(schema.noticedSenders)
        .where(
          and(
            eq(schema.noticedSenders.channel, channel),
            gt(schema.noticedSenders.noticedAt, new Date(now - DAY_MS)),
          ),
        )
        .get()?.value ?? 0;
    if (today >= STRANGER_NOTICES_PER_DAY) return { notify: false };
    this.#db
      .insert(schema.noticedSenders)
      .values({ channel, channelUserId: sender.channelUserId, noticedAt: new Date(now) })
      .run();
    return { notify: true, ownerChannelUserId: owner.channelUserId };
  }

  /**
   * Re-enables a disabled identity, on an owner-authenticated command (Story 3.10). A pending one
   * isn't enabled here: only pairing proves an account is the owner's.
   */
  enableIdentity(identity: ChannelIdentity): IdentityResult {
    if (isValidIdentity(identity) && this.#identity(identity)?.status === "pending") {
      return { ok: false, reason: "not_paired" };
    }
    return this.#setStatus(identity, "enabled");
  }

  disableIdentity(identity: ChannelIdentity): IdentityResult {
    return this.#setStatus(identity, "disabled");
  }

  /** Whether the owner registered, so the admin API can tell "no owner yet" from a refusal. */
  ownerExists(): boolean {
    return this.#owner() !== undefined;
  }

  /**
   * The first run (ADR-0013): registers the owner with their Cloudflare Access login as an enabled
   * identity, in one step. The caller holds the proof, a valid bootstrap token from the deploy and an
   * Access JWT for `accessSub`. It works only while no owner exists.
   */
  bootstrapOwner(userId: string, accessSub: string): OwnerResult {
    if (!isNonEmpty(userId) || !isNonEmpty(accessSub)) {
      return { ok: false, reason: "invalid_user" };
    }
    if (this.#owner()) return { ok: false, reason: "owner_exists" };
    const at = new Date();
    this.#db.transaction((tx) => {
      tx.insert(schema.users).values({ userId, role: "owner", createdAt: at }).run();
      tx.insert(schema.identities)
        .values({
          channel: ACCESS_SOURCE,
          channelUserId: accessSub,
          userId,
          status: "enabled",
          updatedAt: at,
        })
        .run();
      for (const action of ["owner.registered", "identity.added", "identity.enabled"] as const) {
        tx.insert(schema.auditLog)
          .values({
            at,
            action,
            userId,
            channel: action === "owner.registered" ? null : ACCESS_SOURCE,
          })
          .run();
      }
    });
    return { ok: true };
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
      .select({
        userId: schema.users.userId,
        role: schema.users.role,
        timeZone: schema.users.timeZone,
      })
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
    return { admitted: true, userId: user.userId, role: user.role, timeZone: user.timeZone };
  }

  /** Sets a user's time zone, stored in its canonical IANA spelling. */
  setTimeZone(userId: string, timeZone: string): TimeZoneResult {
    const canonical = canonicalTimeZone(timeZone);
    if (!canonical) return { ok: false, reason: "invalid_time_zone" };
    const user = this.#db
      .select({ timeZone: schema.users.timeZone })
      .from(schema.users)
      .where(eq(schema.users.userId, userId))
      .get();
    if (!user) return { ok: false, reason: "unknown_user" };
    if (user.timeZone === canonical) return { ok: true, timeZone: canonical };
    this.#db.transaction((tx) => {
      tx.update(schema.users)
        .set({ timeZone: canonical })
        .where(eq(schema.users.userId, userId))
        .run();
      tx.insert(schema.auditLog)
        .values({ at: new Date(), action: "user.time_zone_changed", userId })
        .run();
    });
    return { ok: true, timeZone: canonical };
  }

  #identity(identity: ChannelIdentity) {
    return this.#db
      .select({ userId: schema.identities.userId, status: schema.identities.status })
      .from(schema.identities)
      .where(this.#identityKey(identity))
      .get();
  }

  #identityKey(identity: ChannelIdentity) {
    return and(
      eq(schema.identities.channel, identity.channel),
      eq(schema.identities.channelUserId, identity.channelUserId),
    );
  }

  #user(userId: string) {
    return this.#db
      .select({ userId: schema.users.userId })
      .from(schema.users)
      .where(eq(schema.users.userId, userId))
      .get();
  }

  #failureKey(identity: ChannelIdentity) {
    return and(
      eq(schema.pairingFailures.channel, identity.channel as ChannelId),
      eq(schema.pairingFailures.channelUserId, identity.channelUserId),
    );
  }

  #failures(identity: ChannelIdentity) {
    return this.#db.select().from(schema.pairingFailures).where(this.#failureKey(identity)).get();
  }

  /** Counts a wrong code; the fifth within the window locks the sender out for as long. */
  #recordFailure(identity: ChannelIdentity, now: number): void {
    const previous = this.#failures(identity);
    const recent = previous && now - previous.lastFailureAt.getTime() < PAIRING_LOCK_MS;
    const failures = (recent ? previous.count : 0) + 1;
    const locked = failures >= MAX_PAIRING_FAILURES;
    const values = {
      count: locked ? 0 : failures,
      lastFailureAt: new Date(now),
      lockedUntil: locked ? new Date(now + PAIRING_LOCK_MS) : null,
    };
    this.#db.transaction((tx) => {
      tx.insert(schema.pairingFailures)
        .values({
          channel: identity.channel as ChannelId,
          channelUserId: identity.channelUserId,
          ...values,
        })
        .onConflictDoUpdate({
          target: [schema.pairingFailures.channel, schema.pairingFailures.channelUserId],
          set: values,
        })
        .run();
      if (locked) {
        tx.insert(schema.auditLog)
          .values({ at: new Date(now), action: "pairing.locked", channel: identity.channel })
          .run();
      }
    });
  }

  #owner() {
    return this.#db
      .select({ userId: schema.users.userId })
      .from(schema.users)
      .where(eq(schema.users.role, "owner"))
      .get();
  }

  #setStatus(identity: ChannelIdentity, status: "enabled" | "disabled"): IdentityResult {
    // The owner's Access login changes only through the bootstrap, so nothing can lock them out.
    if (!isValidIdentity(identity)) return { ok: false, reason: "invalid_identity" };
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
// An Access identity enters only through `bootstrapOwner`.
function isValidIdentity(identity: ChannelIdentity): boolean {
  return (
    (CHANNEL_IDS as readonly string[]).includes(identity?.channel) &&
    isNonEmpty(identity?.channelUserId)
  );
}

/** A code from the pairing alphabet: 32 symbols, so each random byte maps to one evenly. */
function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH));
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join("");
}

function randomHex(length: number): string {
  return [...crypto.getRandomValues(new Uint8Array(length))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant time, so how much of a guess matched doesn't show in how long the check took. */
async function sameHash(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
