import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceContext, loadConfig } from "@zeptly-social/core";
import { createDatabase } from "@zeptly-social/database";
import { createLogger } from "@zeptly-social/observability";
import { buildApp } from "../app.js";
import { HmacServiceAuthenticator } from "../auth.js";

/**
 * Writes the committed OpenAPI artifact (openapi/openapi.json). With --check it
 * fails when the committed artifact is out of date (used in CI).
 * No database connection is opened: route registration never touches the DB.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const out = path.join(root, "openapi", "openapi.json");

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  ZEPTLY_SERVICE_SECRET: "x".repeat(48),
  OUTSTAND_API_KEY: "openapi-generation",
  OUTSTAND_WEBHOOK_SECRET: "openapi-generation-secret",
  PUBLIC_BASE_URL: "https://social.zeptly.example",
});
const logger = createLogger({ service: "openapi", level: "silent" });
const database = createDatabase(config.DATABASE_URL, { max: 1 });
const app = await buildApp({
  ctx: createServiceContext({ config, db: database.db, logger }),
  authenticator: new HmacServiceAuthenticator(config.ZEPTLY_SERVICE_SECRET),
  logger: false,
  readiness: { check: async () => ({}) },
});
await app.ready();
const doc = `${JSON.stringify(app.swagger(), null, 2)}\n`;
await app.close();
await database.close();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {
    /* missing */
  }
  if (current !== doc) {
    process.stderr.write("openapi/openapi.json is out of date. Run `pnpm openapi:generate` and commit the result.\n");
    process.exit(1);
  }
  process.stdout.write("openapi/openapi.json is up to date\n");
} else {
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, doc);
  process.stdout.write(`wrote ${path.relative(root, out)}\n`);
}
