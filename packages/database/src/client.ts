import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number; applicationName?: string } = {}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "outstand-gateway",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** Cheap readiness probe. */
export async function ping(pool: pg.Pool): Promise<void> {
  await pool.query("select 1");
}
