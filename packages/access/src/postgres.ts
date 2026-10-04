import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "./schema.ts";
import type { AccessDb } from "./service.ts";

/** Postgres providers Kelpie can use (ADR-0007). Another provider adds a member and a case. */
export type PostgresProvider = "neon";

export interface PostgresConfig {
  provider: PostgresProvider;
  /** The Hyperdrive binding's connection string. */
  connectionString: string;
}

/**
 * Opens the system-of-record database for one request, with node-postgres as the Hyperdrive guide
 * for Drizzle requires (ADR-0012). The Worker needs `nodejs_compat`. Call `close()` when done.
 */
export async function openPostgres(
  config: PostgresConfig,
): Promise<{ db: AccessDb; close: () => Promise<void> }> {
  switch (config.provider) {
    case "neon": {
      const client = new Client({ connectionString: config.connectionString });
      await client.connect();
      return { db: drizzle(client, { schema }), close: () => client.end() };
    }
  }
}
