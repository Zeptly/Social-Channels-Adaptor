import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

/**
 * Environment contract (docs/RAILWAY.md). Validated on startup; the process
 * exits with a clear message when mandatory configuration is absent.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ZEPTLY_SERVICE_SECRET: z.string().min(32, "ZEPTLY_SERVICE_SECRET must be at least 32 characters"),
  /** Previous secret accepted during rotation (optional). */
  ZEPTLY_SERVICE_SECRET_PREVIOUS: optionalNonEmpty,
  OUTSTAND_API_KEY: z.string().min(1, "OUTSTAND_API_KEY is required"),
  OUTSTAND_WEBHOOK_SECRET: z.string().min(16, "OUTSTAND_WEBHOOK_SECRET is required (min 16 characters)"),
  OUTSTAND_API_BASE_URL: z.url().default("https://api.outstand.so/v1"),
  OUTSTAND_SCHEDULING_HORIZON_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Safety margin subtracted from the provider horizon when handing off (clock skew, tick gaps). */
  OUTSTAND_HANDOFF_MARGIN_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(60),
  API_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Public HTTPS origin of the API (provider OAuth redirect target). */
  PUBLIC_BASE_URL: z.url("PUBLIC_BASE_URL must be the public https origin of the API"),
  /** Comma-separated origins Zeptly may use as provisioning returnUrl (open-redirect protection). */
  ALLOWED_RETURN_URL_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean),
    ),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2000),
  OUTSTAND_LIVE_TESTS: bool,
});

export type AppConfig = z.infer<typeof ConfigSchema> & { port: number };

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const c = parsed.data;
  const problems: string[] = [];
  if (c.NODE_ENV === "production") {
    if (!c.PUBLIC_BASE_URL.startsWith("https://")) problems.push("PUBLIC_BASE_URL must use https in production");
    if (c.ALLOWED_RETURN_URL_ORIGINS.length === 0) problems.push("ALLOWED_RETURN_URL_ORIGINS must list at least one Zeptly origin in production");
  }
  if (problems.length) throw new ConfigError(problems);
  return { ...c, port: c.API_PORT ?? c.PORT ?? 8080 };
}
