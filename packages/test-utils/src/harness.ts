import { createLogger, type Logger } from "@zeptly-social/observability";
import { createDatabase, type DatabaseHandle, runMigrations } from "@zeptly-social/database";
import { FAKE_BASE, FakeOutstand } from "./fake-outstand.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/zeptly_social_test";
export const TEST_SERVICE_SECRET = "test-service-secret-0123456789-abcdefghijklmnop";
export const TEST_WEBHOOK_SECRET = "whsec_test_0123456789abcdef";
export const TEST_OUTSTAND_KEY = "test-outstand-key-abcdef123456";
export const TEST_PUBLIC_BASE_URL = "https://social.zeptly.test";
export const TEST_RETURN_ORIGIN = "https://app.zeptly.test";

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    ZEPTLY_SERVICE_SECRET: TEST_SERVICE_SECRET,
    OUTSTAND_API_KEY: TEST_OUTSTAND_KEY,
    OUTSTAND_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    OUTSTAND_API_BASE_URL: FAKE_BASE,
    OUTSTAND_SCHEDULING_HORIZON_DAYS: "30",
    PUBLIC_BASE_URL: TEST_PUBLIC_BASE_URL,
    ALLOWED_RETURN_URL_ORIGINS: TEST_RETURN_ORIGIN,
    LOG_LEVEL: "silent",
    ...overrides,
  };
}

let migrated: Promise<void> | undefined;

export async function openTestDatabase(): Promise<DatabaseHandle> {
  migrated ??= runMigrations({ url: TEST_DATABASE_URL, log: () => undefined });
  await migrated;
  return createDatabase(TEST_DATABASE_URL, { max: 5, applicationName: "zeptly-social-test" });
}

export async function resetDatabase(handle: DatabaseHandle): Promise<void> {
  const res = await handle.pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'");
  const tables = res.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (tables) await handle.pool.query(`truncate ${tables} restart identity cascade`);
}

export function silentLogger(): Logger {
  return createLogger({ service: "test", level: process.env.TEST_LOG_LEVEL ?? "silent" });
}

/** Controllable clock for scheduling tests. */
export class TestClock {
  constructor(private t: number = Date.now()) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
  set(d: Date): void {
    this.t = d.getTime();
  }
}

export { FakeOutstand };
