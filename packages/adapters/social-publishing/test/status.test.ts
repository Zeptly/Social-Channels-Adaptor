import { describe, expect, it } from "vitest";
import { GatewayError } from "@zeptly-gateway/gateway-contract";
import { aggregatePostStatus } from "../src/index.js";

describe("aggregatePostStatus", () => {
  it("is published only when every target published", () => {
    expect(aggregatePostStatus(["published", "published"], "publishing")).toBe("published");
    expect(aggregatePostStatus(["published", "failed"], "publishing")).toBe("partially_published");
    expect(aggregatePostStatus(["published", "cancelled"], "publishing")).toBe("partially_published");
  });

  it("reports failure and in-flight states", () => {
    expect(aggregatePostStatus(["failed", "failed"], "publishing")).toBe("failed");
    expect(aggregatePostStatus(["published", "publishing"], "publishing")).toBe("publishing");
    expect(aggregatePostStatus(["scheduled", "scheduled"], "scheduled")).toBe("scheduled");
    expect(aggregatePostStatus(["pending"], "queued")).toBe("queued");
    expect(aggregatePostStatus(["cancelled"], "scheduled")).toBe("cancelled");
  });

  it("never changes drafts or cancelled posts", () => {
    expect(aggregatePostStatus(["published"], "draft")).toBe("draft");
    expect(aggregatePostStatus(["published"], "cancelled")).toBe("cancelled");
  });
});

describe("GatewayError", () => {
  it("serializes to the canonical error body", () => {
    const e = new GatewayError("CAPABILITY_NOT_SUPPORTED", "nope", { details: { network: "facebook" } });
    expect(e.status).toBe(422);
    expect(e.toJSON("req-1")).toEqual({ error: { code: "CAPABILITY_NOT_SUPPORTED", message: "nope", retryable: false, details: { network: "facebook" }, requestId: "req-1" } });
    expect(new GatewayError("PROVIDER_RATE_LIMITED", "x").retryable).toBe(true);
  });
});
