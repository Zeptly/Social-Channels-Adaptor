import { randomUUID } from "node:crypto";
import { ProviderError } from "@zeptly-social/provider-contract";
import { type Logger, redactString } from "@zeptly-social/observability";
import { z } from "zod";

export const PROVIDER = "outstand";

export const envelopeSchema = z
  .object({
    success: z.boolean().optional(),
    data: z.unknown().optional(),
    error: z.unknown().optional(),
    message: z.unknown().optional(),
    details: z.unknown().optional(),
  })
  .loose();

export interface OutstandHttpOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  /** Upper bound on honoured Retry-After before giving the error back to the caller (job-level retry). */
  maxRetryAfterMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Supplies the correlation id of the current operation, if any. */
  requestId?: () => string | undefined;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Mutating request whose failure after send may have been applied remotely. */
  mutating?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Defensive Outstand transport:
 *  - Bearer auth, server-side only; the key is registered for value redaction.
 *  - Per-request timeout (AbortSignal.timeout), no redirects followed.
 *  - Retries ONLY when safe: GET/DELETE, or POST carrying an Idempotency-Key.
 *    Retry on network error, timeout, 429 and 5xx with exponential backoff + jitter.
 *  - X-Request-Id correlation on every call.
 *  - Errors become ProviderError with a redacted, bounded message.
 */
export class OutstandHttp {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryAfterMs: number;
  readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly requestId: () => string | undefined;

  constructor(opts: OutstandHttpOptions) {
    if (!opts.apiKey) throw new Error("OUTSTAND_API_KEY is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
    this.requestId = opts.requestId ?? (() => undefined);
  }

  async request(path: string, opts: RequestOptions = {}): Promise<unknown> {
    const method = opts.method ?? "GET";
    const retrySafe = method === "GET" || method === "DELETE" || Boolean(opts.idempotencyKey);
    const attempts = retrySafe ? this.maxAttempts : 1;
    const requestId = this.requestId() ?? randomUUID();
    let lastErr: ProviderError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once(path, method, opts, requestId, attempt);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        lastErr = err;
        if (!err.retryable || attempt >= attempts) throw err;
        const retryAfterMs = (err.retryAfterSeconds ?? 0) * 1000;
        if (retryAfterMs > this.maxRetryAfterMs) throw err;
        const backoff = this.retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * this.retryBaseMs);
        await sleep(Math.max(backoff, retryAfterMs));
      }
    }
    throw lastErr ?? new ProviderError(PROVIDER, "network", "request failed", { retryable: true, ambiguous: Boolean(opts.mutating) });
  }

  private async once(path: string, method: string, opts: RequestOptions, requestId: string, attempt: number): Promise<unknown> {
    const started = performance.now();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "X-Request-Id": requestId,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const logPath = path.split("?")[0] ?? path;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      this.logger?.warn({ provider: PROVIDER, method, path: logPath, attempt, requestId, outcome: isTimeout ? "timeout" : "network_error" }, "outstand request failed");
      throw new ProviderError(PROVIDER, isTimeout ? "timeout" : "network", `Outstand ${method} ${logPath} ${isTimeout ? "timed out" : "network error"}`, {
        retryable: true,
        ambiguous: Boolean(opts.mutating),
      });
    }
    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    this.logger?.debug(
      {
        provider: PROVIDER,
        method,
        path: logPath,
        status: res.status,
        attempt,
        requestId,
        latencyMs: Math.round(performance.now() - started),
        rateLimitRemaining: res.headers.get("x-ratelimit-remaining") ?? undefined,
        idempotentReplay: res.headers.get("idempotency-replay") ?? undefined,
      },
      "outstand request",
    );
    if (!res.ok) throw this.httpError(res, method, logPath, json, text, Boolean(opts.mutating));
    if (json === undefined && text) {
      throw new ProviderError(PROVIDER, "protocol", `Outstand ${method} ${logPath} returned non-JSON`, {
        status: res.status,
        retryable: false,
        ambiguous: Boolean(opts.mutating),
      });
    }
    const env = envelopeSchema.safeParse(json);
    if (env.success && env.data.success === false) {
      throw new ProviderError(PROVIDER, "validation", `Outstand ${method} ${logPath} failed: ${errorMessage(json)}`, {
        status: res.status,
        retryable: false,
        ambiguous: false,
        details: { providerMessage: errorMessage(json) },
      });
    }
    return json;
  }

  private httpError(res: Response, method: string, path: string, json: unknown, text: string, mutating: boolean): ProviderError {
    const status = res.status;
    const msg = json !== undefined ? errorMessage(json) : redactString(text).slice(0, 200) || `HTTP ${status}`;
    const base = `Outstand ${method} ${path} → ${status}: ${msg}`;
    const ra = Number(res.headers.get("retry-after"));
    const retryAfterSeconds = Number.isFinite(ra) && ra > 0 ? ra : undefined;
    const details = { providerStatus: status, providerMessage: msg };
    if (status === 401 || status === 403) return new ProviderError(PROVIDER, "auth", base, { status, retryable: false, ambiguous: false, details });
    if (status === 404) return new ProviderError(PROVIDER, "not_found", base, { status, retryable: false, ambiguous: false, details });
    if (status === 409) {
      // Same Idempotency-Key still in flight, or reused with a different body.
      return new ProviderError(PROVIDER, "conflict", base, { status, retryable: true, ambiguous: true, retryAfterSeconds, details });
    }
    if (status === 429) return new ProviderError(PROVIDER, "rate_limit", base, { status, retryable: true, ambiguous: false, retryAfterSeconds, details });
    if (status >= 500) return new ProviderError(PROVIDER, "server", base, { status, retryable: true, ambiguous: mutating, retryAfterSeconds, details });
    return new ProviderError(PROVIDER, "validation", base, { status, retryable: false, ambiguous: false, details });
  }
}

export function errorMessage(json: unknown): string {
  const env = envelopeSchema.safeParse(json);
  if (!env.success) return "unknown error";
  const parts = [env.data.error, env.data.message].filter((p): p is string => typeof p === "string" && p.length > 0);
  return redactString(parts.join(": ") || "unknown error").slice(0, 500);
}

/** Unwrap the `{ success, data }` envelope; bare bodies pass through. */
export function unwrap(json: unknown): unknown {
  const env = envelopeSchema.safeParse(json);
  return env.success && env.data.data !== undefined ? env.data.data : json;
}
