import { runMigrations } from "./migrator.js";

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}
runMigrations({ url }).catch((err: unknown) => {
  process.stderr.write(`[migrate] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
