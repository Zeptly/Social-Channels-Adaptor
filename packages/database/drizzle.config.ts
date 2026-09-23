import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/database/src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/zeptly_social" },
  strict: true,
  verbose: true,
});
