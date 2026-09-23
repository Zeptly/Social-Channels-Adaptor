import { z } from "zod";

export const ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "WORKSPACE_FORBIDDEN",
  "NOT_FOUND",
  "CONNECTION_NOT_FOUND",
  "POST_NOT_FOUND",
  "CONVERSATION_NOT_FOUND",
  "MEDIA_NOT_FOUND",
  "PROVISIONING_NOT_FOUND",
  "PROVISIONING_EXPIRED",
  "CONNECTION_OWNERSHIP_CONFLICT",
  "CAPABILITY_NOT_SUPPORTED",
  "NETWORK_NOT_SUPPORTED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_REJECTED",
  "MEDIA_INVALID",
  "TARGET_INVALID",
  "TARGET_DROPPED_BY_PROVIDER",
  "PUBLICATION_FAILED",
  "PUBLICATION_STATE_UNKNOWN",
  "REAUTHORIZATION_REQUIRED",
  "CONNECTION_NOT_ACTIVE",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "INVALID_STATE",
  "VALIDATION_ERROR",
  "WEBHOOK_SIGNATURE_INVALID",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  AUTHENTICATION_FAILED: 401,
  WORKSPACE_FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONNECTION_NOT_FOUND: 404,
  POST_NOT_FOUND: 404,
  CONVERSATION_NOT_FOUND: 404,
  MEDIA_NOT_FOUND: 404,
  PROVISIONING_NOT_FOUND: 404,
  PROVISIONING_EXPIRED: 410,
  CONNECTION_OWNERSHIP_CONFLICT: 409,
  CAPABILITY_NOT_SUPPORTED: 422,
  NETWORK_NOT_SUPPORTED: 422,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_REJECTED: 422,
  MEDIA_INVALID: 422,
  TARGET_INVALID: 422,
  TARGET_DROPPED_BY_PROVIDER: 502,
  PUBLICATION_FAILED: 502,
  PUBLICATION_STATE_UNKNOWN: 502,
  REAUTHORIZATION_REQUIRED: 409,
  CONNECTION_NOT_ACTIVE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  INVALID_STATE: 409,
  VALIDATION_ERROR: 400,
  WEBHOOK_SIGNATURE_INVALID: 401,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export interface SocialErrorOptions {
  status?: number;
  details?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * Canonical error. Everything that crosses the public API boundary is
 * translated into one of these; provider error strings never leak verbatim
 * into `message` (sanitized provider diagnostics live under `details.provider`).
 */
export class SocialError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: SocialErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SocialError";
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
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

export function isSocialError(err: unknown): err is SocialError {
  return err instanceof SocialError;
}

export const ApiErrorBodySchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      retryable: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
      requestId: z.string().optional(),
    }),
  })
  .meta({ id: "ApiError" });

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
