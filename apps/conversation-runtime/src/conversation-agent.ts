import { canonicalTimeZone } from "@kelpie/access";
import { CAPABILITIES, type ChannelCapabilities } from "@kelpie/channels";
import type { AgentConfig, AgentSettings } from "@kelpie/config";
import {
  deliveredReply,
  planDelivery,
  planFlush,
  stampOf,
  withoutTypedStamps,
} from "@kelpie/conversation";
import type { AssistantMessage, ChatMessage, LlmEvent } from "@kelpie/llm";
import { Agent, type FiberRecoveryContext } from "agents";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import { type ConversationPorts, type Destination, portsFor } from "./ports.ts";
import * as schema from "./schema.ts";

/** Bounds on what one conversation accepts. */
export const LIMITS = {
  /** Longer messages are refused; channels already cap theirs well below this. */
  maxTextLength: 16_000,
  /** With this many messages buffered, the turn starts at once. */
  maxBuffered: 50,
};

const FIBER_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** One inbound message, already admitted by `ingress` (ADR-0004, ADR-0015). */
export interface InboundMessage {
  /** The agent that answers; its `AgentHost` holds the settings. */
  agentId: string;
  providerMessageId: string;
  /** The admitted author. */
  userId: string;
  text: string;
  destination: Destination;
  /** When the provider says the message was sent (epoch ms). */
  sentAt: number;
  /** The author's IANA time zone, from their admission, or null while they haven't set one. */
  timeZone: string | null;
}

export type IngestResult =
  | {
      status: "accepted" | "duplicate";
      /** When the buffered messages will be answered, or null if a turn already started. */
      flushAt: number | null;
    }
  | {
      status: "rejected";
      reason: "destination_mismatch" | "agent_mismatch" | "too_long" | "empty";
    };

interface TurnInFlight {
  controller: AbortController;
  call?: { cancel(): void };
}

/**
 * The hot path of one conversation (ADR-0002):
 * - messages are deduplicated, then buffered until the user goes quiet (a re-armed schedule,
 *   never `setTimeout`), with the quiet window from the end-of-turn decision;
 * - each turn runs as a durable fiber that calls the model, plans the bubbles and persists them in
 *   an outbox before sending them with pacing;
 * - a new message interrupts the turn in flight: the turn is settled at once (unsent bubbles
 *   dropped, history keeping only what the user saw) and its model call is cancelled, so the next
 *   turn always starts from a settled history;
 * - after an eviction, recovery resends only bubbles still pending.
 *
 * Settings come from the agent's `AgentHost`: read when a flush is planned and when a turn starts,
 * and kept with the turn. The object trusts its caller, `ingress`, which admits senders before
 * anything else. A conversation is bound to the destination and the agent of its first message.
 */
export class ConversationAgent extends Agent<Env> {
  readonly #db: DrizzleSqliteDODatabase<typeof schema>;
  readonly #inFlight = new Map<number, TurnInFlight>();
  /** Serializes flush planning, so concurrent messages can't arm two schedules. */
  #planning: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = drizzle(ctx.storage, { schema });
    // If a migration fails the object resets, and the next request retries it.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#db, migrations);
      } catch (error) {
        console.error("ConversationAgent migration failed", errorName(error));
        throw error;
      }
    });
  }

  get #ports(): ConversationPorts {
    return portsFor(this.env);
  }

  /**
   * Accepts one message from `ingress`. Nothing here waits on another object before the message is
   * stored and the turn in flight interrupted, so concurrent messages can't interleave there.
   */
  async ingest(message: InboundMessage): Promise<IngestResult> {
    const now = this.#ports.now();
    if (message.text.length > LIMITS.maxTextLength)
      return { status: "rejected", reason: "too_long" };
    // A stamp the user typed could fake when the message was sent.
    const text = withoutTypedStamps(message.text);
    if (text.trim() === "") return { status: "rejected", reason: "empty" };
    const sentAt = plausibleSendTime(message.sentAt, now);
    const stamp = stampOf(sentAt, canonicalTimeZone(message.timeZone));
    capabilitiesFor(message.destination.channel);
    const bound = this.#get<Destination | null>("destination", null);
    if (bound && !sameDestination(bound, message.destination)) {
      return { status: "rejected", reason: "destination_mismatch" };
    }
    const agentId = this.#get<string | null>("agentId", null);
    if (agentId && agentId !== message.agentId) {
      return { status: "rejected", reason: "agent_mismatch" };
    }
    if (!bound) this.#set("destination", message.destination);
    if (!agentId) this.#set("agentId", message.agentId);

    const inserted = this.#db
      .insert(schema.inbound)
      .values({
        providerMessageId: message.providerMessageId,
        userId: message.userId,
        text,
        receivedAt: now,
        sentAt,
        stamp,
      })
      .onConflictDoNothing({ target: schema.inbound.providerMessageId })
      .returning({ id: schema.inbound.id })
      .all();
    if (inserted.length === 0) {
      // A retry of a message whose flush was never planned (reading the settings failed) plans it
      // now; otherwise it would wait for the next message.
      await this.#serialized(async () => {
        if (this.#get("plannedEpoch", 0) !== this.#epoch()) await this.#plan(this.#epoch(), now);
      });
      return { status: "duplicate", flushAt: this.#get<number | null>("flushAt", null) };
    }

    this.#interrupt();
    const epoch = this.#epoch() + 1;
    this.#set("epoch", epoch);
    await this.#serialized(() => this.#plan(epoch, now));
    return { status: "accepted", flushAt: this.#get<number | null>("flushAt", null) };
  }

  /**
   * Starts a turn with the buffered messages. The flush schedule calls it with the buffer epoch it
   * was armed for and is ignored once a newer message re-armed it; calling it again, or with
   * nothing buffered, does nothing. It never interrupts: every message already interrupted the
   * turn in flight when it arrived, so a running turn here is one that answers everything.
   */
  async flush(armed?: { epoch: number }): Promise<void> {
    if (armed && armed.epoch !== this.#epoch()) return;
    if (this.#pendingInbound().length === 0) return;
    const { settings, promptVersion } = await this.#config();
    // Other calls ran while this waited: a newer message may have re-armed the flush, or another
    // flush may have claimed the buffer.
    if (armed && armed.epoch !== this.#epoch()) return;
    if (this.#pendingInbound().length === 0) return;
    await this.#cancelFlushSchedule();
    const pending = this.#pendingInbound();
    const now = this.#ports.now();
    const turnId = this.#db.transaction((tx) => {
      const { id } = tx
        .insert(schema.turns)
        .values({
          generation: this.#generation(),
          status: "running",
          attempts: 0,
          systemVersion: promptVersion,
          settings,
          createdAt: now,
        })
        .returning({ id: schema.turns.id })
        .get();
      // The text moves into history; the inbound row keeps only what dedupe needs.
      tx.update(schema.inbound)
        .set({ turnId: id, text: "" })
        .where(
          inArray(
            schema.inbound.id,
            pending.map((row) => row.id),
          ),
        )
        .run();
      for (const run of byAuthor(pending)) {
        tx.insert(schema.history)
          .values({
            turnId: id,
            role: "user",
            userId: run.userId,
            systemVersion: promptVersion,
            message: { role: "user", parts: [{ type: "text", text: run.text }] },
            createdAt: now,
          })
          .run();
      }
      return id;
    });
    await this.deleteFibers({ settledBefore: new Date(now - FIBER_RETENTION_MS) });
    await this.startFiber("turn", () => this.#runTurn(turnId), {
      idempotencyKey: `turn:${turnId}`,
      metadata: { turnId },
    });
  }

  /** The conversation as the model will see it next. */
  async history(): Promise<ChatMessage[]> {
    if (!this.#get<string | null>("agentId", null)) return [];
    return this.#messages((await this.#config()).promptVersion);
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

  /** The status of every turn, for inspection. */
  turns(): { id: number; status: string; attempts: number }[] {
    return this.#db
      .select({ id: schema.turns.id, status: schema.turns.status, attempts: schema.turns.attempts })
      .from(schema.turns)
      .orderBy(asc(schema.turns.id))
      .all();
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "turn") return;
    const turnId = (ctx.metadata as { turnId?: unknown } | null)?.turnId;
    if (typeof turnId !== "number" || !Number.isInteger(turnId)) {
      console.error("ConversationAgent: a turn fiber has no turn id", { fiberId: ctx.id });
      return { status: "completed" as const };
    }
    try {
      const turn = this.#turn(turnId);
      if (turn?.status === "running") {
        if (turn.generation !== this.#generation()) this.#settle(turnId, "interrupted");
        // Continue in a new fiber: pacing must not run inside the recovery hook's time limit.
        else {
          await this.startFiber("turn", () => this.#resume(turnId), {
            idempotencyKey: `turn:${turnId}:recovered:${ctx.id}`,
            metadata: { turnId },
          });
        }
      }
    } catch (error) {
      console.error("ConversationAgent: turn recovery failed", { turnId, error: errorName(error) });
      this.#settle(turnId, "failed");
    }
    return { status: "completed" as const };
  }

  async #runTurn(turnId: number): Promise<void> {
    await this.#guarded(turnId, (controller) => this.#call(turnId, controller));
  }

  /** Picks a recovered turn back up: resend pending bubbles, or call the model again once. */
  async #resume(turnId: number): Promise<void> {
    await this.#guarded(turnId, async (controller) => {
      const turn = this.#turn(turnId);
      if (turn?.status !== "running") return;
      if (this.#outboxCount(turnId) > 0) {
        // A bubble caught mid-send may or may not have arrived; it is sent again.
        this.#db
          .update(schema.outbox)
          .set({ status: "pending" })
          .where(and(eq(schema.outbox.turnId, turnId), eq(schema.outbox.status, "sending")))
          .run();
        await this.#deliver(turnId, controller.signal);
      } else if (turn.attempts < 2) {
        await this.#call(turnId, controller);
      } else {
        this.#settle(turnId, "failed");
      }
    });
  }

  /** Runs one step of a turn; any failure settles the turn instead of leaving it running. */
  async #guarded(
    turnId: number,
    step: (controller: AbortController) => Promise<void>,
  ): Promise<void> {
    const flight: TurnInFlight = { controller: new AbortController() };
    this.#inFlight.set(turnId, flight);
    try {
      await step(flight.controller);
    } catch (error) {
      console.error("ConversationAgent: turn failed", { turnId, error: errorName(error) });
      this.#settle(turnId, "failed");
    } finally {
      if (this.#inFlight.get(turnId) === flight) this.#inFlight.delete(turnId);
    }
  }

  async #call(turnId: number, controller: AbortController): Promise<void> {
    const turn = this.#turn(turnId);
    if (turn?.status !== "running") return;
    if (turn.generation !== this.#generation()) {
      this.#settle(turnId, "interrupted");
      return;
    }
    this.#db
      .update(schema.turns)
      .set({ attempts: turn.attempts + 1 })
      .where(eq(schema.turns.id, turnId))
      .run();

    const settings = settingsOf(turn);
    const call = await this.#ports.generate(settings.tier, {
      system: settings.systemPrompt,
      messages: this.#messages(turn.systemVersion),
      maxOutputTokens: settings.maxOutputTokens,
    });
    const flight = this.#inFlight.get(turnId);
    if (flight) flight.call = call;
    if (controller.signal.aborted) {
      call.cancel();
      return;
    }

    let finish: Extract<LlmEvent, { type: "finish" }> | undefined;
    try {
      for await (const event of call.events) {
        if (event.type === "finish") finish = event;
      }
    } catch (error) {
      // An interruption cancels the call; the turn is already settled.
      if (controller.signal.aborted || !this.#isRunning(turnId)) return;
      throw error;
    }
    if (!this.#isRunning(turnId)) return;
    if (!finish) throw new Error("The model stream ended without a reply");
    if (finish.reason === "refusal") {
      this.#db
        .update(schema.turns)
        .set({ status: "refused" })
        .where(eq(schema.turns.id, turnId))
        .run();
      return;
    }

    const bubbles = planDelivery(
      textOf(finish.message),
      settings.conversational,
      capabilitiesFor(this.#destination().channel),
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
    await this.#deliver(turnId, controller.signal);
  }

  /** Sends the turn's pending bubbles in order, stopping as soon as the turn is settled. */
  async #deliver(turnId: number, signal: AbortSignal): Promise<void> {
    const turn = this.#turn(turnId);
    if (turn?.status !== "running") return;
    const { conversational } = settingsOf(turn);
    const destination = this.#destination();
    const capabilities = capabilitiesFor(destination.channel);
    const rows = this.#db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.turnId, turnId), eq(schema.outbox.status, "pending")))
      .orderBy(asc(schema.outbox.seq))
      .all();

    for (const row of rows) {
      if (signal.aborted || !this.#isRunning(turnId)) return;
      if (conversational && capabilities.typing.supported) {
        try {
          await this.#ports.typing(destination);
        } catch (error) {
          // "Typing" is a courtesy; failing to show it doesn't stop the reply.
          console.error("ConversationAgent: typing failed", { turnId, error: errorName(error) });
        }
      }
      try {
        await this.#ports.sleep(row.delayMs, signal);
      } catch {
        return;
      }
      if (!this.#isRunning(turnId)) return;
      this.#setBubble(row.id, "sending");
      try {
        await this.#ports.send(destination, row.text);
      } catch (error) {
        if (this.#isRunning(turnId)) this.#setBubble(row.id, "pending");
        throw error;
      }
      // If the turn was settled during the send, settling already counted this bubble as sent.
      if (this.#isRunning(turnId)) this.#setBubble(row.id, "sent");
    }
    this.#settle(turnId, "finished");
  }

  /**
   * Ends a turn: unsent bubbles are dropped, a bubble mid-send counts as sent, and history records
   * what the user saw, under the system prompt version the turn ran with.
   */
  #settle(turnId: number, outcome: "finished" | "interrupted" | "failed"): void {
    const turn = this.#turn(turnId);
    if (turn?.status !== "running") return;
    const rows = this.#db
      .select({ text: schema.outbox.text, status: schema.outbox.status })
      .from(schema.outbox)
      .where(eq(schema.outbox.turnId, turnId))
      .orderBy(asc(schema.outbox.seq))
      .all();
    const sent = rows.filter((row) => row.status === "sent" || row.status === "sending").length;
    const kept = turn.reply
      ? deliveredReply(
          turn.reply,
          rows.map((row) => row.text),
          sent,
        )
      : null;
    const status =
      outcome === "failed"
        ? "failed"
        : rows.length > 0 && sent === rows.length
          ? "delivered"
          : "interrupted";
    const now = this.#ports.now();
    this.#db.transaction((tx) => {
      tx.update(schema.outbox)
        .set({ status: "sent", sentAt: now })
        .where(and(eq(schema.outbox.turnId, turnId), eq(schema.outbox.status, "sending")))
        .run();
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
            systemVersion: turn.systemVersion,
            message: kept,
            createdAt: now,
          })
          .run();
      }
      // History holds what was kept; the full reply and the settings aren't needed any more.
      tx.update(schema.turns)
        .set({ status, reply: null, settings: null })
        .where(eq(schema.turns.id, turnId))
        .run();
    });
  }

  /** A new message arrived: every turn in flight is settled now and its work stopped. */
  #interrupt(): void {
    const running = this.#db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(eq(schema.turns.status, "running"))
      .all();
    if (running.length === 0) return;
    this.#set("generation", this.#generation() + 1);
    for (const { id } of running) {
      this.#settle(id, "interrupted");
      const flight = this.#inFlight.get(id);
      flight?.controller.abort();
      flight?.call?.cancel();
    }
  }

  async #plan(epoch: number, now: number): Promise<void> {
    if (epoch !== this.#epoch()) return;
    const pending = this.#pendingInbound();
    if (pending.length === 0) return;
    const flushAt =
      pending.length >= LIMITS.maxBuffered
        ? now
        : await planFlush(
            pending.map((row) => ({ text: row.text, receivedAt: row.receivedAt })),
            (await this.#config()).settings,
            this.#ports.qualifier,
          );
    // A newer message arrived while the settings or the decision were awaited, and plans with the
    // fuller buffer; or a flush already claimed the buffer.
    if (epoch !== this.#epoch() || this.#pendingInbound().length === 0) return;
    await this.#cancelFlushSchedule();
    if (flushAt <= now) {
      await this.flush();
    } else {
      const schedule = await this.schedule(new Date(flushAt), "flush", { epoch });
      this.#set("flushSchedule", schedule.id);
      this.#set("flushAt", flushAt);
    }
    this.#set("plannedEpoch", epoch);
  }

  #serialized(step: () => Promise<void>): Promise<void> {
    const run = this.#planning.then(step);
    this.#planning = run.catch(() => {});
    return run;
  }

  async #cancelFlushSchedule(): Promise<void> {
    const id = this.#get<string | null>("flushSchedule", null);
    this.#set("flushSchedule", null);
    this.#set("flushAt", null);
    if (id) await this.cancelSchedule(id);
  }

  /** History for a request under `systemVersion`: replies from other versions lose native output. */
  #messages(systemVersion: number): ChatMessage[] {
    return this.#db
      .select({ message: schema.history.message, systemVersion: schema.history.systemVersion })
      .from(schema.history)
      .orderBy(asc(schema.history.id))
      .all()
      .map(({ message, systemVersion: version }) => {
        if (message.role !== "assistant" || version === systemVersion) return message;
        const { native: _native, ...neutral } = message;
        return neutral;
      });
  }

  #pendingInbound() {
    return this.#db
      .select()
      .from(schema.inbound)
      .where(isNull(schema.inbound.turnId))
      .orderBy(asc(schema.inbound.id))
      .all();
  }

  #turn(turnId: number) {
    return this.#db.select().from(schema.turns).where(eq(schema.turns.id, turnId)).get();
  }

  #isRunning(turnId: number): boolean {
    return this.#turn(turnId)?.status === "running";
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

  #setBubble(id: number, status: "pending" | "sending" | "sent"): void {
    this.#db
      .update(schema.outbox)
      .set({ status, ...(status === "sent" ? { sentAt: this.#ports.now() } : {}) })
      .where(eq(schema.outbox.id, id))
      .run();
  }

  /** The agent's current settings, from its `AgentHost`. */
  async #config(): Promise<AgentConfig> {
    const agentId = this.#get<string | null>("agentId", null);
    if (!agentId) throw new Error("The conversation has no agent yet");
    return this.env.AGENT_HOST.getByName(agentId).config();
  }

  #generation(): number {
    return this.#get("generation", 0);
  }

  #epoch(): number {
    return this.#get("epoch", 0);
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

/** The settings a running turn started with. */
function settingsOf(turn: { settings: AgentSettings | null }): AgentSettings {
  if (!turn.settings) throw new Error("The turn has no settings");
  return turn.settings;
}

/** The provider's send time, or the arrival time when that one is missing or in the future. */
function plausibleSendTime(sentAt: number, now: number): number {
  const CLOCK_SKEW_MS = 5 * 60_000;
  return Number.isSafeInteger(sentAt) && sentAt > 0 && sentAt <= now + CLOCK_SKEW_MS ? sentAt : now;
}

function capabilitiesFor(channel: Destination["channel"]): ChannelCapabilities {
  const capabilities: ChannelCapabilities | undefined = (
    CAPABILITIES as Partial<Record<Destination["channel"], ChannelCapabilities>>
  )[channel];
  if (!capabilities) throw new Error(`Channel ${channel} isn't supported yet`);
  return capabilities;
}

function sameDestination(a: Destination, b: Destination): boolean {
  return a.channel === b.channel && a.threadId === b.threadId;
}

/**
 * Consecutive messages from one author become one history message, each keeping its author. Each
 * message starts with its stamp, unless the message before it in the same run has the same one.
 */
function byAuthor(rows: readonly { userId: string; text: string; stamp: string | null }[]) {
  const runs: { userId: string; lines: string[]; lastStamp: string | null }[] = [];
  for (const row of rows) {
    let run = runs.at(-1);
    if (!run || run.userId !== row.userId) {
      run = { userId: row.userId, lines: [], lastStamp: null };
      runs.push(run);
    }
    run.lines.push(
      row.stamp && row.stamp !== run.lastStamp ? `${row.stamp} ${row.text}` : row.text,
    );
    run.lastStamp = row.stamp;
  }
  return runs.map((run) => ({ userId: run.userId, text: run.lines.join("\n") }));
}

function textOf(message: AssistantMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

/** Error names only: messages can quote conversation content, which is personal data. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
