import { ConfigError, createServiceContext, loadConfig } from "@zeptly-social/core";
import { appliedMigrationCount, createDatabase, ping } from "@zeptly-social/database";
import { createLogger } from "@zeptly-social/observability";
import { API_VERSION, buildApp } from "./app.js";
import { HmacServiceAuthenticator } from "./auth.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const logger = createLogger({ service: "zeptly-social-api", level: config.LOG_LEVEL });
  const database = createDatabase(config.DATABASE_URL, { applicationName: "zeptly-social-api" });
  const ctx = createServiceContext({ config, db: database.db, logger });
  const app = await buildApp({
    ctx,
    authenticator: new HmacServiceAuthenticator(config.ZEPTLY_SERVICE_SECRET, config.ZEPTLY_SERVICE_SECRET_PREVIOUS),
    logger,
    version: API_VERSION,
    readiness: {
      async check() {
        const checks: Record<string, { ok: boolean; detail?: string }> = {};
        try {
          await ping(database.pool);
          checks.database = { ok: true };
        } catch {
          checks.database = { ok: false, detail: "database unreachable" };
        }
        const applied = checks.database.ok ? await appliedMigrationCount(database.pool) : 0;
        checks.migrations = applied > 0 ? { ok: true, detail: `${applied} applied` } : { ok: false, detail: "no migrations applied" };
        // Configuration was validated at startup; provider credentials are not probed here to avoid provider traffic.
        checks.configuration = { ok: true };
        return checks;
      },
    },
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      await database.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info({ port: config.port }, "zeptly-social api listening");
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
