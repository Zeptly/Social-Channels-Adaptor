import { z } from "zod";

/**
 * Canonical gateway error model (Gateway Contract v1).
 *
 * The contract defines the codes every provider gateway shares. Typed capability
 * contracts register their own codes (e.g. Social Publishing registers
 * POST_NOT_FOUND) through `defineErrorCodes`, extending the `ErrorCodeRegistry`
 * interface by declaration merging so codes stay type-checked end to end.
 */
export interface ErrorCodeRegistry {
  AUTHENTICATION_FAILED: true;
  WORKSPACE_FORBIDDEN: true;
  NOT_FOUND: true;
  CONNECTION_NOT_FOUND: true;
  PROVISIONING_NOT_FOUND: true;
  PROVISIONING_EXPIRED: true;
  CONNECTION_OWNERSHIP_CONFLICT: true;
  CONNECTION_NOT_ACTIVE: true;
  REAUTHORIZATION_REQUIRED: true;
  CAPABILITY_NOT_SUPPORTED: true;
  NETWORK_NOT_SUPPORTED: true;
  PROVIDER_UNAVAILABLE: true;
  PROVIDER_RATE_LIMITED: true;
  PROVIDER_REJECTED: true;
  IDEMPOTENCY_CONFLICT: true;
  IDEMPOTENCY_KEY_REQUIRED: true;
  INVALID_STATE: true;
  VALIDATION_ERROR: true;
  WEBHOOK_SIGNATURE_INVALID: true;
  RATE_LIMITED: true;
  INTERNAL_ERROR: true;
}

export type ErrorCode = keyof ErrorCodeRegistry;

export interface ErrorCodeSpec {
  status: number;
  retryable?: boolean;
  description?: string;
}

const REGISTRY = new Map<string, ErrorCodeSpec>();

/** Register error codes (with HTTP status and default retryability). Idempotent. */
export function defineErrorCodes(specs: Record<string, ErrorCodeSpec>): void {
  for (const [code, spec] of Object.entries(specs)) REGISTRY.set(code, spec);
}

/** Every code registered so far (gateway + loaded capability contracts). */
export function registeredErrorCodes(): string[] {
  return [...REGISTRY.keys()].sort();
}

defineErrorCodes({
  AUTHENTICATION_FAILED: { status: 401, description: "Missing or invalid service signature" },
  WORKSPACE_FORBIDDEN: { status: 403, description: "Missing or invalid workspace identity" },
  NOT_FOUND: { status: 404 },
  CONNECTION_NOT_FOUND: { status: 404 },
  PROVISIONING_NOT_FOUND: { status: 404 },
  PROVISIONING_EXPIRED: { status: 410 },
  CONNECTION_OWNERSHIP_CONFLICT: { status: 409, description: "Provider account already belongs to another workspace" },
  CONNECTION_NOT_ACTIVE: { status: 409 },
  REAUTHORIZATION_REQUIRED: { status: 409 },
  CAPABILITY_NOT_SUPPORTED: { status: 422 },
  NETWORK_NOT_SUPPORTED: { status: 422, description: "The channel/network is not offered by this gateway" },
  PROVIDER_UNAVAILABLE: { status: 503, retryable: true },
  PROVIDER_RATE_LIMITED: { status: 429, retryable: true },
  PROVIDER_REJECTED: { status: 422 },
  IDEMPOTENCY_CONFLICT: { status: 409 },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400 },
  INVALID_STATE: { status: 409 },
  VALIDATION_ERROR: { status: 400 },
  WEBHOOK_SIGNATURE_INVALID: { status: 401 },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: true },
});

export interface GatewayErrorOptions {
  status?: number;
  details?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * Canonical error. Everything that crosses a gateway's public boundary is one of
 * these; provider error strings never appear in `message` (sanitized upstream
 * diagnostics live under `details.provider`).
 */
export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GatewayError";
    const spec = REGISTRY.get(code);
    this.code = code;
    this.status = options.status ?? spec?.status ?? 500;
    this.details = options.details;
    this.retryable = options.retryable ?? spec?.retryable ?? false;
  }

  toJSON(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

export function isGatewayError(err: unknown): err is GatewayError {
  return err instanceof GatewayError;
}

export const ApiErrorBodySchema = z
  .object({
    error: z.object({
      code: z.string().describe("Canonical error code (see GET /v1/gateway → errorCodes and docs/GATEWAY-CONTRACT.md)"),
      message: z.string(),
      retryable: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
      requestId: z.string().optional(),
    }),
  })
  .meta({ id: "ApiError" });

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/* ------------------------------------------------------------------ */
/* Upstream (provider) failures                                        */
/* ------------------------------------------------------------------ */

export type UpstreamErrorKind =
  | "auth"
  | "validation"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "protocol"
  | "unsupported";

export interface UpstreamErrorOptions {
  status?: number;
  retryable: boolean;
  /** The upstream may have applied a mutating request (timeout/5xx after send). */
  ambiguous: boolean;
  retryAfterSeconds?: number;
  /** Sanitized diagnostics only — never tokens or keys. */
  details?: Record<string, unknown>;
}

/**
 * Failure of a call to the gateway's upstream provider. Provider clients throw
 * subclasses of this; gateway infrastructure reasons only about these generic
 * properties (retryable / ambiguous / retry-after) and translates them into
 * canonical errors. Never crosses the public API as-is.
 */
export class UpstreamError extends Error {
  readonly provider: string;
  readonly kind: UpstreamErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(provider: string, kind: UpstreamErrorKind, message: string, opts: UpstreamErrorOptions) {
    super(message);
    this.name = "UpstreamError";
    this.provider = provider;
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.ambiguous = opts.ambiguous;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.details = opts.details;
  }
}

export function isUpstreamError(err: unknown): err is UpstreamError {
  return err instanceof UpstreamError;
}
