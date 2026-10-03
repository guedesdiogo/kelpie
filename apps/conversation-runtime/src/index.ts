import { DurableObject } from "cloudflare:workers";
import { computeFlushAt, type DebouncePolicy } from "@kelpie/conversation";

// Fixed for this harness; per-agent configuration arrives with the ConversationAgent (phase 1).
const POLICY: DebouncePolicy = { quietMs: 2_000, maxWaitMs: 8_000 };

export interface Fragment {
  providerMessageId: string;
  text: string;
}

export interface IngestResult {
  duplicate: boolean;
  flushAt: number | null;
}

/**
 * Buffers a user's fragmented messages and flushes them as one batch once the user goes quiet
 * (ADR-0002). The alarm is re-armed on every new fragment; storage and the alarm survive eviction.
 */
export class DebounceBuffer extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fragments (
        provider_message_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        batch_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        flushed_at INTEGER NOT NULL
      );
    `);
  }

  async ingest(fragment: Fragment, now = Date.now()): Promise<IngestResult> {
    const { rowsWritten } = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO fragments (provider_message_id, text, received_at) VALUES (?, ?, ?)",
      fragment.providerMessageId,
      fragment.text,
      now,
    );
    if (rowsWritten === 0) {
      return { duplicate: true, flushAt: await this.ctx.storage.getAlarm() };
    }

    const { firstAt, lastAt } = this.ctx.storage.sql
      .exec<{ firstAt: number; lastAt: number }>(
        "SELECT MIN(received_at) AS firstAt, MAX(received_at) AS lastAt FROM fragments WHERE batch_id IS NULL",
      )
      .one();
    const flushAt = computeFlushAt({ firstAt, lastAt }, POLICY);
    await this.ctx.storage.setAlarm(flushAt);
    return { duplicate: false, flushAt };
  }

  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const pending = sql
      .exec<{ text: string }>(
        "SELECT text FROM fragments WHERE batch_id IS NULL ORDER BY received_at, rowid",
      )
      .toArray();
    if (pending.length === 0) return;

    this.ctx.storage.transactionSync(() => {
      const { id } = sql
        .exec<{ id: number }>(
          "INSERT INTO batches (text, flushed_at) VALUES (?, ?) RETURNING id",
          pending.map((fragment) => fragment.text).join("\n"),
          Date.now(),
        )
        .one();
      sql.exec("UPDATE fragments SET batch_id = ? WHERE batch_id IS NULL", id);
    });
  }

  async batches(): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ text: string }>("SELECT text FROM batches ORDER BY id")
      .toArray()
      .map((batch) => batch.text);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
