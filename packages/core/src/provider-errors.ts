import { type ErrorCode, SocialError } from "@zeptly-social/domain";
import { ProviderError } from "@zeptly-social/provider-contract";
import { redactString } from "@zeptly-social/observability";

/**
 * Provider error → canonical error. Zeptly never parses provider strings; the
 * sanitized provider message is kept only under details.provider.
 */
export function toSocialError(err: unknown, fallback: ErrorCode = "PROVIDER_UNAVAILABLE"): SocialError {
  if (err instanceof SocialError) return err;
  if (err instanceof ProviderError) {
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
        return new SocialError("PROVIDER_RATE_LIMITED", "The social provider is rate limiting requests", { details, retryable: true });
      case "auth":
        return new SocialError("PROVIDER_UNAVAILABLE", "The social provider rejected this service's credentials", { details, retryable: false });
      case "validation":
        return new SocialError("PROVIDER_REJECTED", "The social provider rejected the request", { details, retryable: false });
      case "not_found":
        return new SocialError("NOT_FOUND", "The provider resource no longer exists", { details, retryable: false });
      case "unsupported":
        return new SocialError("CAPABILITY_NOT_SUPPORTED", "The provider does not support this operation", { details, retryable: false });
      case "conflict":
      case "server":
      case "network":
      case "timeout":
      case "protocol":
        return new SocialError(fallback, "The social provider is unavailable or returned an unexpected response", { details, retryable: err.retryable });
    }
  }
  return new SocialError("INTERNAL_ERROR", "Unexpected internal error", { retryable: true });
}

export function safeMessage(err: unknown): string {
  if (err instanceof Error) return redactString(err.message).slice(0, 1000);
  return "unknown error";
}
