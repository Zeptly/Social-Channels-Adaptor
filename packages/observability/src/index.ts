import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger };

/**
 * Secret redaction, applied in two layers:
 *  1. key-name redaction for structured objects (logs, audit metadata, stored payloads);
 *  2. value redaction of well-known secret shapes and of registered secret values
 *     (the configured API keys / signing secrets themselves).
 */
const SENSITIVE_KEY =
  /^(pass(word)?|app_?password|secret|.*_secret|token|access_?token|refresh_?token|page_?access_?token|id_?token|api[-_]?key|authorization|cookie|set-cookie|signature|x-outstand-signature|x-zeptly-signature|credentials?|private[-_]?key|session_?token|network_data|upload_?url)$/i;

export const REDACTED = "[REDACTED]";

const registered = new Set<string>();

/** Register a runtime secret so its exact value is scrubbed from any string. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) registered.add(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, `$1${REDACTED}@`],
  [/([?&](?:api[_-]?key|token|access_token|signature|sig|X-Amz-Signature|X-Amz-Credential|session)=)[^&\s"]+/gi, `$1${REDACTED}`],
];

export function redactString(input: string): string {
  let out = input;
  for (const v of registered) out = out.split(v).join(REDACTED);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 10) return "[TRUNCATED]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value instanceof Date) return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) } as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && v !== null && v !== undefined && v !== "" ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export interface CreateLoggerOptions {
  level?: string;
  service: string;
  pretty?: boolean;
}

/** Paths redacted by pino itself (defence in depth on top of redact()). */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-zeptly-signature']",
  "req.headers['x-outstand-signature']",
  "headers.authorization",
  "*.authorization",
  "*.Authorization",
  "*.password",
  "*.appPassword",
  "*.app_password",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.accessToken",
  "*.access_token",
  "*.refresh_token",
  "*.secret",
  "*.credentials",
  "*.sessionToken",
  "*.uploadUrl",
  "*.upload_url",
];

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? "info",
    base: { service: opts.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: LOG_REDACT_PATHS, censor: REDACTED },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      // Value-level scrubbing of string arguments (e.g. messages embedding a key).
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === "string" ? redactString(a) : a)) as Parameters<typeof method>;
        method.apply(this, scrubbed);
      },
    },
    serializers: {
      err: (err: unknown) => {
        if (err instanceof Error) {
          const e = err as Error & { code?: unknown; kind?: unknown; status?: unknown };
          return { type: e.name, message: redactString(e.message), code: e.code, kind: e.kind, status: e.status, stack: e.stack ? redactString(e.stack) : undefined };
        }
        return redact(err);
      },
    },
  };
  return pino(options);
}

/** Structured operation timing: logs outcome + latency for traceability (spec §27). */
export async function timed<T>(log: Logger, operation: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    log.info({ operation, outcome: "success", latencyMs: Math.round(performance.now() - started), ...redact(fields) }, `${operation} succeeded`);
    return result;
  } catch (err) {
    log.warn({ operation, outcome: "failure", latencyMs: Math.round(performance.now() - started), ...redact(fields), err }, `${operation} failed`);
    throw err;
  }
}
