import { appliedMigrationCount, createDatabase, ping } from "@zeptly-gateway/database";
import { HmacServiceAuthenticator } from "@zeptly-gateway/gateway-core";
import { createLogger } from "@zeptly-gateway/observability";
import { ConfigError, createOutstandGateway, loadConfig } from "@zeptly-gateway/outstand-gateway";
import { API_VERSION, buildApp } from "./app.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const logger = createLogger({ service: "outstand-gateway-api", level: config.LOG_LEVEL });
  const database = createDatabase(config.DATABASE_URL, { applicationName: "outstand-gateway-api" });
  const readiness = {
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
  };
  const runtime = createOutstandGateway({ config, db: database.db, logger, version: API_VERSION, healthProbe: () => readiness.check() });
  const app = await buildApp({
    runtime,
    authenticator: new HmacServiceAuthenticator(config.ZEPTLY_SERVICE_SECRET, config.ZEPTLY_SERVICE_SECRET_PREVIOUS),
    logger,
    version: API_VERSION,
    readiness,
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
  logger.info({ port: config.port }, "outstand gateway api listening");
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
