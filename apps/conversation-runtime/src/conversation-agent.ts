import { CAPABILITIES, type ChannelCapabilities } from "@kelpie/channels";
import { deliveredReply, planDelivery, planFlush } from "@kelpie/conversation";
import type { AssistantMessage, ChatMessage, LlmEvent, ModelTier } from "@kelpie/llm";
import type { QuietWindowPolicy } from "@kelpie/qualifier";
import { Agent, type FiberRecoveryContext } from "agents";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import { type ConversationPorts, type Destination, portsFor } from "./ports.ts";
import * as schema from "./schema.ts";

/** Per-conversation settings. They come from `AgentHost` once it exists; until then, defaults. */
export interface ConversationSettings {
  /** Merge fragments and split replies into paced bubbles; off answers each message at once. */
  conversational: boolean;
  tier: ModelTier;
  /** Changing it starts a new prompt version: earlier replies replay without native output. */
  systemPrompt: string;
  maxOutputTokens: number;
  quietWindow: QuietWindowPolicy;
  maxWaitMs: number;
}

export const DEFAULT_SETTINGS: ConversationSettings = {
  conversational: true,
  tier: "cheap",
  systemPrompt: "You are a helpful assistant. Reply in the language the user writes in.",
  maxOutputTokens: 1_024,
  quietWindow: { finishedMs: 1_500, defaultMs: 3_000, unfinishedMs: 6_000 },
  maxWaitMs: 10_000,
};

/** One inbound message, already admitted by `ingress` (ADR-0004, ADR-0015). */
export interface InboundMessage {
  providerMessageId: string;
  /** The admitted author. */
  userId: string;
  text: string;
  destination: Destination;
}

export interface IngestResult {
  duplicate: boolean;
  /** When the buffered messages will be answered, or null if they already were. */
  flushAt: number | null;
}

interface ActiveTurn {
  turnId: number;
  controller: AbortController;
  call?: { cancel(): void };
}

/**
 * The hot path of one conversation (ADR-0002):
 * - messages are deduplicated, then buffered until the user goes quiet (a re-armed schedule,
 *   never `setTimeout`), with the quiet window from the end-of-turn decision;
 * - each turn runs as a durable fiber that calls the model, plans the bubbles and persists them in
 *   an outbox before sending them with pacing;
 * - a new message interrupts the turn in flight: the model call is cancelled, unsent bubbles are
 *   dropped, and history keeps only what the user saw, so the next turn knows what was said;
 * - after an eviction, recovery resends only bubbles still pending.
 */
export class ConversationAgent extends Agent<Env> {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;
  #active: ActiveTurn | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    // If a migration fails the object resets, and the next request retries it.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#db, migrations);
      } catch (error) {
        console.error("ConversationAgent migration failed", error);
        throw error;
      }
    });
  }

  get #ports(): ConversationPorts {
    return portsFor(this.env);
  }

  /** Overrides settings for this conversation. A new system prompt starts a new prompt version. */
  configure(changes: Partial<ConversationSettings>): ConversationSettings {
    const current = this.#settings();
    const next = { ...current, ...changes };
    if (next.systemPrompt !== current.systemPrompt) {
      this.#set("systemVersion", this.#systemVersion() + 1);
    }
    this.#set("settings", next);
    return next;
  }

  /** Accepts one message. `now` defaults to the clock; tests pass it to control the schedule. */
  async ingest(message: InboundMessage, now = this.#ports.now()): Promise<IngestResult> {
    capabilitiesFor(message.destination.channel);
    const inserted = this.#db
      .insert(schema.inbound)
      .values({
        providerMessageId: message.providerMessageId,
        userId: message.userId,
        text: message.text,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.inbound.providerMessageId })
      .all();
    if (inserted.length === 0) {
      return { duplicate: true, flushAt: this.#get<number | null>("flushAt", null) };
    }
    this.#set("destination", message.destination);
    this.#interrupt();

    const pending = this.#pendingInbound();
    const flushAt = await planFlush(
      pending.map((row) => ({ text: row.text, receivedAt: row.receivedAt })),
      this.#settings(),
      this.#ports.qualifier,
    );
    await this.#rearm(flushAt, now);
    return { duplicate: false, flushAt: this.#get<number | null>("flushAt", null) };
  }

  /**
   * Starts a turn with the buffered messages. The flush schedule calls it; calling it again, or
   * with nothing buffered, does nothing.
   */
  async flush(): Promise<void> {
    await this.#cancelFlushSchedule();
    const pending = this.#pendingInbound();
    const first = pending[0];
    if (!first) return;
    const now = this.#ports.now();
    const turnId = this.#db.transaction((tx) => {
      const { id } = tx
        .insert(schema.turns)
        .values({ generation: this.#generation(), status: "running", attempts: 0, createdAt: now })
        .returning({ id: schema.turns.id })
        .get();
      for (const row of pending) {
        tx.update(schema.inbound)
          .set({ turnId: id })
          .where(eq(schema.inbound.providerMessageId, row.providerMessageId))
          .run();
      }
      tx.insert(schema.history)
        .values({
          turnId: id,
          role: "user",
          userId: first.userId,
          systemVersion: this.#systemVersion(),
          message: {
            role: "user",
            parts: [{ type: "text", text: pending.map((row) => row.text).join("\n") }],
          },
          createdAt: now,
        })
        .run();
      return id;
    });
    await this.startFiber("turn", () => this.#runTurn(turnId), {
      idempotencyKey: `turn:${turnId}`,
      metadata: { turnId },
    });
  }

  /** The conversation as the model will see it next. */
  history(): ChatMessage[] {
    return this.#messages();
  }

  /** The bubbles of every turn, for inspection. */
  outbox(): { turnId: number; seq: number; text: string; status: string }[] {
    return this.#db
      .select({
        turnId: schema.outbox.turnId,
        seq: schema.outbox.seq,
        text: schema.outbox.text,
        status: schema.outbox.status,
      })
      .from(schema.outbox)
      .orderBy(asc(schema.outbox.turnId), asc(schema.outbox.seq))
      .all();
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "turn") return;
    const turnId = Number((ctx.metadata as { turnId?: number } | null)?.turnId);
    const turn = this.#turn(turnId);
    if (!turn || turn.status !== "running") return { status: "completed" as const };

    if (turn.generation !== this.#generation()) {
      this.#settle(turnId);
    } else if (this.#outboxCount(turnId) > 0) {
      // The reply was planned: resend only what is still pending.
      this.#active = { turnId, controller: new AbortController() };
      await this.#deliver(turnId);
    } else if (turn.attempts < 2) {
      await this.#runTurn(turnId);
    } else {
      this.#setStatus(turnId, "failed");
    }
    return { status: "completed" as const };
  }

  async #runTurn(turnId: number): Promise<void> {
    const turn = this.#turn(turnId);
    if (!turn || turn.status !== "running") return;
    if (turn.generation !== this.#generation()) {
      this.#settle(turnId);
      return;
    }
    this.#db
      .update(schema.turns)
      .set({ attempts: turn.attempts + 1 })
      .where(eq(schema.turns.id, turnId))
      .run();

    const settings = this.#settings();
    const active: ActiveTurn = { turnId, controller: new AbortController() };
    this.#active = active;
    let finish: Extract<LlmEvent, { type: "finish" }> | undefined;
    try {
      const call = await this.#ports.generate(settings.tier, {
        system: settings.systemPrompt,
        messages: this.#messages(),
        maxOutputTokens: settings.maxOutputTokens,
      });
      active.call = call;
      if (active.controller.signal.aborted) call.cancel();
      else {
        for await (const event of call.events) {
          if (event.type === "finish") finish = event;
        }
      }
    } catch (error) {
      if (this.#isStale(turn.generation)) {
        this.#settle(turnId);
        return;
      }
      console.error("ConversationAgent: the model call failed", error);
      this.#setStatus(turnId, "failed");
      return;
    }
    if (this.#isStale(turn.generation)) {
      this.#settle(turnId);
      return;
    }
    if (!finish || finish.reason === "refusal") {
      this.#setStatus(turnId, "refused");
      return;
    }

    const destination = this.#destination();
    const bubbles = planDelivery(
      textOf(finish.message),
      settings.conversational,
      capabilitiesFor(destination.channel),
    );
    const reply = finish.message;
    this.#db.transaction((tx) => {
      tx.update(schema.turns).set({ reply }).where(eq(schema.turns.id, turnId)).run();
      bubbles.forEach((bubble, seq) => {
        tx.insert(schema.outbox)
          .values({ turnId, seq, text: bubble.text, delayMs: bubble.delayMs, status: "pending" })
          .run();
      });
    });
    await this.#deliver(turnId);
  }

  /** Sends the turn's pending bubbles in order, stopping as soon as the turn is interrupted. */
  async #deliver(turnId: number): Promise<void> {
    const turn = this.#turn(turnId);
    if (!turn) return;
    const settings = this.#settings();
    const destination = this.#destination();
    const capabilities = capabilitiesFor(destination.channel);
    const signal = this.#active?.turnId === turnId ? this.#active.controller.signal : undefined;
    const rows = this.#db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.turnId, turnId), eq(schema.outbox.status, "pending")))
      .orderBy(asc(schema.outbox.seq))
      .all();

    for (const row of rows) {
      if (this.#isStale(turn.generation)) break;
      try {
        if (settings.conversational && capabilities.typing.supported) {
          await this.#ports.typing(destination);
        }
        await this.#ports.sleep(row.delayMs, signal ?? new AbortController().signal);
      } catch {
        break;
      }
      if (this.#isStale(turn.generation)) break;
      await this.#ports.send(destination, row.text);
      this.#db
        .update(schema.outbox)
        .set({ status: "sent", sentAt: this.#ports.now() })
        .where(eq(schema.outbox.id, row.id))
        .run();
    }
    this.#settle(turnId);
  }

  /** Ends a turn: drops unsent bubbles and records in history what the user actually saw. */
  #settle(turnId: number): void {
    const turn = this.#turn(turnId);
    if (!turn || turn.status !== "running") return;
    const rows = this.#db
      .select({ text: schema.outbox.text, status: schema.outbox.status })
      .from(schema.outbox)
      .where(eq(schema.outbox.turnId, turnId))
      .orderBy(asc(schema.outbox.seq))
      .all();
    const sent = rows.filter((row) => row.status === "sent").length;
    const kept = turn.reply
      ? deliveredReply(
          turn.reply,
          rows.map((row) => row.text),
          sent,
        )
      : null;
    const now = this.#ports.now();
    this.#db.transaction((tx) => {
      tx.update(schema.outbox)
        .set({ status: "cancelled" })
        .where(and(eq(schema.outbox.turnId, turnId), eq(schema.outbox.status, "pending")))
        .run();
      if (kept) {
        tx.insert(schema.history)
          .values({
            turnId,
            role: "assistant",
            userId: null,
            systemVersion: this.#systemVersion(),
            message: kept,
            createdAt: now,
          })
          .run();
      }
      tx.update(schema.turns)
        .set({ status: rows.length > 0 && sent === rows.length ? "delivered" : "interrupted" })
        .where(eq(schema.turns.id, turnId))
        .run();
    });
    if (this.#active?.turnId === turnId) this.#active = undefined;
  }

  /** A new message arrived: the turn in flight, if any, stops where it is. */
  #interrupt(): void {
    const running = this.#db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(eq(schema.turns.status, "running"))
      .get();
    if (!running) return;
    this.#set("generation", this.#generation() + 1);
    this.#active?.controller.abort();
    this.#active?.call?.cancel();
  }

  async #rearm(flushAt: number, now: number): Promise<void> {
    await this.#cancelFlushSchedule();
    if (flushAt <= now) {
      await this.flush();
      return;
    }
    const schedule = await this.schedule(new Date(flushAt), "flush");
    this.#set("flushSchedule", schedule.id);
    this.#set("flushAt", flushAt);
  }

  async #cancelFlushSchedule(): Promise<void> {
    const id = this.#get<string | null>("flushSchedule", null);
    if (id) await this.cancelSchedule(id);
    this.#set("flushSchedule", null);
    this.#set("flushAt", null);
  }

  #messages(): ChatMessage[] {
    const version = this.#systemVersion();
    return this.#db
      .select({ message: schema.history.message, systemVersion: schema.history.systemVersion })
      .from(schema.history)
      .orderBy(asc(schema.history.id))
      .all()
      .map(({ message, systemVersion }) => {
        // Reasoning produced under an earlier system prompt is no longer valid to replay.
        if (message.role !== "assistant" || systemVersion === version) return message;
        const { native: _native, ...neutral } = message;
        return neutral;
      });
  }

  #pendingInbound() {
    return this.#db
      .select()
      .from(schema.inbound)
      .where(isNull(schema.inbound.turnId))
      .orderBy(asc(schema.inbound.receivedAt), asc(schema.inbound.providerMessageId))
      .all();
  }

  #turn(turnId: number) {
    return this.#db.select().from(schema.turns).where(eq(schema.turns.id, turnId)).get();
  }

  #outboxCount(turnId: number): number {
    return (
      this.#db
        .select({ value: count() })
        .from(schema.outbox)
        .where(eq(schema.outbox.turnId, turnId))
        .get()?.value ?? 0
    );
  }

  #setStatus(turnId: number, status: "refused" | "failed"): void {
    this.#db.update(schema.turns).set({ status }).where(eq(schema.turns.id, turnId)).run();
    if (this.#active?.turnId === turnId) this.#active = undefined;
  }

  #isStale(generation: number): boolean {
    return generation !== this.#generation();
  }

  #settings(): ConversationSettings {
    return { ...DEFAULT_SETTINGS, ...this.#get<Partial<ConversationSettings>>("settings", {}) };
  }

  #generation(): number {
    return this.#get("generation", 0);
  }

  #systemVersion(): number {
    return this.#get("systemVersion", 0);
  }

  #destination(): Destination {
    const destination = this.#get<Destination | null>("destination", null);
    if (!destination) throw new Error("The conversation has no destination yet");
    return destination;
  }

  #get<T>(key: string, fallback: T): T {
    const row = this.#db
      .select({ value: schema.state.value })
      .from(schema.state)
      .where(eq(schema.state.key, key))
      .get();
    return row ? (row.value as T) : fallback;
  }

  #set(key: string, value: unknown): void {
    this.#db
      .insert(schema.state)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.state.key, set: { value } })
      .run();
  }
}

function capabilitiesFor(channel: Destination["channel"]): ChannelCapabilities {
  const capabilities: ChannelCapabilities | undefined = (
    CAPABILITIES as Partial<Record<Destination["channel"], ChannelCapabilities>>
  )[channel];
  if (!capabilities) throw new Error(`Channel ${channel} isn't supported yet`);
  return capabilities;
}

function textOf(message: AssistantMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}
