import { appliedMigrationCount, createDatabase } from "@zeptly-gateway/database";
import { createLogger } from "@zeptly-gateway/observability";
import { ConfigError, createOutstandGateway, loadConfig } from "@zeptly-gateway/outstand-gateway";
import { Worker } from "./runtime.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const logger = createLogger({ service: "outstand-gateway-worker", level: config.LOG_LEVEL });
  const database = createDatabase(config.DATABASE_URL, { applicationName: "outstand-gateway-worker", max: config.WORKER_CONCURRENCY + 2 });

  // Wait for migrations (the pre-deploy step) before touching tables.
  for (let i = 0; ; i++) {
    const applied = await appliedMigrationCount(database.pool).catch(() => 0);
    if (applied > 0) break;
    if (i >= 60) {
      logger.fatal("database has no applied migrations after 5 minutes");
      process.exit(1);
    }
    logger.warn("waiting for migrations");
    await new Promise((r) => setTimeout(r, 5000));
  }

  // The worker never dispatches from request context; inline dispatch is an API concern.
  const runtime = createOutstandGateway({ config, db: database.db, logger, inlineDispatch: false });
  const worker = new Worker(runtime, { concurrency: config.WORKER_CONCURRENCY, pollIntervalMs: config.WORKER_POLL_INTERVAL_MS, version: process.env.RAILWAY_GIT_COMMIT_SHA });
  worker.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    const timer = setTimeout(() => process.exit(1), 30_000);
    await worker.stop();
    await database.close();
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
