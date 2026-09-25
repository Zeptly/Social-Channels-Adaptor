import { type ErrorCode, GatewayError, UpstreamError } from "@zeptly-gateway/gateway-contract";
import { redactString } from "@zeptly-gateway/observability";

/**
 * Upstream (provider) failure → canonical gateway error. Zeptly never parses
 * provider strings; the sanitized provider message is kept only under
 * details.provider.
 */
export function toGatewayError(err: unknown, fallback: ErrorCode = "PROVIDER_UNAVAILABLE"): GatewayError {
  if (err instanceof GatewayError) return err;
  if (err instanceof UpstreamError) {
    const details = {
      provider: {
        name: err.provider,
        kind: err.kind,
        ...(err.status ? { status: err.status } : {}),
        message: redactString(err.message).slice(0, 300),
      },
      ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    };
    switch (err.kind) {
      case "rate_limit":
        return new GatewayError("PROVIDER_RATE_LIMITED", "The provider is rate limiting requests", { details, retryable: true });
      case "auth":
        return new GatewayError("PROVIDER_UNAVAILABLE", "The provider rejected this gateway's credentials", { details, retryable: false });
      case "validation":
        return new GatewayError("PROVIDER_REJECTED", "The provider rejected the request", { details, retryable: false });
      case "not_found":
        return new GatewayError("NOT_FOUND", "The provider resource no longer exists", { details, retryable: false });
      case "unsupported":
        return new GatewayError("CAPABILITY_NOT_SUPPORTED", "The provider does not support this operation", { details, retryable: false });
      case "conflict":
      case "server":
      case "network":
      case "timeout":
      case "protocol":
        return new GatewayError(fallback, "The provider is unavailable or returned an unexpected response", { details, retryable: err.retryable });
    }
  }
  return new GatewayError("INTERNAL_ERROR", "Unexpected internal error", { retryable: true });
}

export function safeMessage(err: unknown): string {
  if (err instanceof Error) return redactString(err.message).slice(0, 1000);
  return "unknown error";
}
