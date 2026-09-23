import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Serialises concurrent migration runs (API + worker pre-deploy both run it). */
export const MIGRATION_LOCK_ID = 7_310_422_031;

/** Repository-root `migrations/` folder, resolved from source or bundled locations. */
export function defaultMigrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src: packages/database/src → ../../../migrations ; bundle: apps/<app>/dist → ../../../migrations
  return path.resolve(here, "../../../migrations");
}

export async function runMigrations(opts: { url: string; migrationsFolder?: string; log?: (m: string) => void }): Promise<void> {
  const log = opts.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const client = new pg.Client({ connectionString: opts.url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    log("[migrate] acquiring advisory lock");
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    const folder = opts.migrationsFolder ?? defaultMigrationsFolder();
    log(`[migrate] applying migrations from ${folder}`);
    await migrate(drizzle(client), { migrationsFolder: folder });
    log("[migrate] done");
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    } catch {
      /* connection may already be gone */
    }
    await client.end();
  }
}

export async function appliedMigrationCount(pool: pg.Pool): Promise<number> {
  try {
    const r = await pool.query<{ n: string }>("select count(*)::text as n from drizzle.__drizzle_migrations");
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}
