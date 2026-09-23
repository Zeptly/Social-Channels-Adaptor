import { OUTSTAND_NETWORKS } from "@zeptly-social/capability-registry";
import { ProviderError } from "@zeptly-social/provider-contract";
import { redact, redactString, registerSecret } from "@zeptly-social/observability";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { aggregatePublicationStatus, backoffFor, handoffHorizonEnd, settleTarget } from "../src/dispatch.js";
import { requestHash } from "../src/posts.js";
import { toSocialError } from "../src/provider-errors.js";
import { assertPublicHttpsUrl, isPublicAddress } from "../src/url-safety.js";
import { validateTargetContent } from "../src/validation.js";

const img = (id = "m1", extra: Partial<{ contentType: string; sizeBytes: number; status: string }> = {}) => ({ id, kind: "image" as const, contentType: "image/jpeg", sizeBytes: 1000, status: "ready", ...extra });
const vid = (id = "v1") => ({ id, kind: "video" as const, contentType: "video/mp4", sizeBytes: 1000, status: "ready" });

describe("network constraint validation", () => {
  it("enforces text limits and required text", () => {
    expect(validateTargetContent("bluesky", OUTSTAND_NETWORKS.bluesky.constraints, { text: "x".repeat(301), media: [], options: {} })[0]).toMatch(/300/);
    expect(validateTargetContent("linkedin", OUTSTAND_NETWORKS.linkedin.constraints, { text: "", media: [img()], options: {} })).toContain("linkedin: text is required");
  });

  it("requires media where the network does (Instagram, TikTok video, YouTube video)", () => {
    expect(validateTargetContent("instagram", OUTSTAND_NETWORKS.instagram.constraints, { text: "hi", media: [], options: {} })).toContain("instagram: at least one media item is required");
    expect(validateTargetContent("tiktok", OUTSTAND_NETWORKS.tiktok.constraints, { text: "hi", media: [img()], options: { privacyLevel: "SELF_ONLY" } }).join()).toMatch(/image media is not supported/);
    expect(validateTargetContent("tiktok", OUTSTAND_NETWORKS.tiktok.constraints, { text: "hi", media: [vid()], options: { privacyLevel: "SELF_ONLY" } })).toEqual([]);
  });

  it("checks mime types, sizes, counts and mixing", () => {
    expect(validateTargetContent("instagram", OUTSTAND_NETWORKS.instagram.constraints, { text: "", media: [img("p", { contentType: "image/png" })], options: {} }).join()).toMatch(/not accepted/);
    expect(validateTargetContent("bluesky", OUTSTAND_NETWORKS.bluesky.constraints, { text: "", media: [img("big", { sizeBytes: 2_000_000 })], options: {} }).join()).toMatch(/exceeds/);
    expect(validateTargetContent("facebook", OUTSTAND_NETWORKS.facebook.constraints, { text: "x", media: [img(), vid()], options: {} }).join()).toMatch(/cannot be mixed/);
    expect(validateTargetContent("pinterest", OUTSTAND_NETWORKS.pinterest.constraints, { text: "", media: [img("a"), img("b")], options: { boardId: "b" } }).join()).toMatch(/at most 1/);
  });

  it("validates verified network options and rejects unknown keys", () => {
    const yt = OUTSTAND_NETWORKS.youtube.constraints;
    expect(validateTargetContent("youtube", yt, { text: "", media: [vid()], options: {} })).toEqual(expect.arrayContaining(['youtube: option "title" is required', 'youtube: option "privacyStatus" is required']));
    expect(validateTargetContent("youtube", yt, { text: "", media: [vid()], options: { title: "T", privacyStatus: "secret" } }).join()).toMatch(/one of public/);
    expect(validateTargetContent("linkedin", OUTSTAND_NETWORKS.linkedin.constraints, { text: "x", media: [], options: { visibility: "PUBLIC" } }).join()).toMatch(/not supported/);
    expect(validateTargetContent("pinterest", OUTSTAND_NETWORKS.pinterest.constraints, { text: "", media: [img("p", { contentType: "image/png" })], options: {} })).toContain('pinterest: option "boardId" is required');
  });
});

describe("dispatch state logic", () => {
  const local = { status: "publishing", platformPostId: null, platformPostUrl: null, publishedAt: null, errorCode: null, errorMessage: null };
  const now = new Date("2026-09-23T10:00:00Z");

  it("a missing provider target becomes an explicit TARGET_DROPPED_BY_PROVIDER failure", () => {
    expect(settleTarget({ ...local, status: "pending" }, undefined, { source: "dispatch", futureSchedule: false, remotePublishedAt: undefined, now })).toMatchObject({ status: "failed", errorCode: "TARGET_DROPPED_BY_PROVIDER" });
  });

  it("a lagging provider view never reverts a known outcome", () => {
    const pub = { ...local, status: "published", platformPostId: "p1" };
    expect(settleTarget(pub, { accountExternalId: "a", status: "pending" }, { source: "reconcile", futureSchedule: false, remotePublishedAt: undefined, now }).status).toBe("published");
    expect(settleTarget(pub, undefined, { source: "webhook", futureSchedule: false, remotePublishedAt: undefined, now }).status).toBe("published");
  });

  it("maps provider statuses", () => {
    const ctx = { source: "reconcile" as const, futureSchedule: true, remotePublishedAt: undefined, now };
    expect(settleTarget(local, { accountExternalId: "a", status: "pending" }, ctx).status).toBe("scheduled");
    expect(settleTarget(local, { accountExternalId: "a", status: "deleted" }, ctx).status).toBe("cancelled");
    expect(settleTarget(local, { accountExternalId: "a", status: "failed", error: "boom" }, ctx)).toMatchObject({ status: "failed", errorCode: "PUBLICATION_FAILED", errorMessage: "boom" });
    expect(settleTarget(local, { accountExternalId: "a", status: "published", platformPostId: "x" }, ctx)).toMatchObject({ status: "published", platformPostId: "x", publishedAt: now });
  });

  it("aggregates publication status with partial results", () => {
    expect(aggregatePublicationStatus(["published", "failed"])).toBe("partially_published");
    expect(aggregatePublicationStatus(["published", "scheduled"])).toBe("accepted");
    expect(aggregatePublicationStatus(["failed"])).toBe("failed");
  });

  it("computes the rolling hand-off horizon from configuration", () => {
    const end = handoffHorizonEnd(now, 30 * 86_400_000, 60 * 60_000);
    expect(end.toISOString()).toBe("2026-10-23T09:00:00.000Z");
    expect(handoffHorizonEnd(now, undefined, 0).getTime()).toBeGreaterThan(now.getTime() + 1e12);
  });

  it("bounded exponential backoff honours Retry-After", () => {
    expect(backoffFor(1)).toBe(60_000);
    expect(backoffFor(99)).toBe(3 * 3600_000);
    expect(backoffFor(1, 600)).toBe(600_000);
  });
});

describe("provider error translation", () => {
  const pe = (kind: ProviderError["kind"], status?: number) => new ProviderError("outstand", kind, "Outstand POST /posts/ → 429: slow", { retryable: kind === "rate_limit", ambiguous: false, ...(status ? { status } : {}), retryAfterSeconds: 30 });
  it("maps provider kinds to canonical codes with sanitized diagnostics", () => {
    expect(toSocialError(pe("rate_limit", 429))).toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true, details: { retryAfterSeconds: 30 } });
    expect(toSocialError(pe("validation", 400)).code).toBe("PROVIDER_REJECTED");
    expect(toSocialError(pe("auth", 401)).code).toBe("PROVIDER_UNAVAILABLE");
    expect(toSocialError(pe("unsupported")).code).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(toSocialError(new Error("boom")).code).toBe("INTERNAL_ERROR");
  });
});

describe("media URL safety (SSRF)", () => {
  it.each(["http://cdn.example/a.jpg", "https://localhost/a.jpg", "https://127.0.0.1/a.jpg", "https://10.1.2.3/a.jpg", "https://169.254.169.254/latest", "https://[::1]/a", "https://user:pw@cdn.example/a.jpg", "https://metadata.internal/a"])(
    "rejects %s",
    async (url) => {
      await expect(assertPublicHttpsUrl(url, { skipDns: true })).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    },
  );
  it("accepts public https URLs", async () => {
    await expect(assertPublicHttpsUrl("https://cdn.example.com/a.jpg", { skipDns: true })).resolves.toBeInstanceOf(URL);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("100.64.1.1")).toBe(false);
    expect(isPublicAddress("::ffff:192.168.1.1")).toBe(false);
  });
});

describe("secret redaction", () => {
  it("redacts sensitive keys and registered secret values", () => {
    registerSecret("super-secret-outstand-key-999");
    expect(redactString("key=super-secret-outstand-key-999 Bearer abcdefghijkl")).toBe("key=[REDACTED] Bearer [REDACTED]");
    expect(redact({ appPassword: "x", nested: { access_token: "t", ok: 1 }, network_data: { a: 1 } })).toEqual({ appPassword: "[REDACTED]", nested: { access_token: "[REDACTED]", ok: 1 }, network_data: "[REDACTED]" });
    expect(redactString("https://s3/upload?X-Amz-Signature=abc&x=1")).toBe("https://s3/upload?X-Amz-Signature=[REDACTED]&x=1");
  });
});

describe("configuration", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    ZEPTLY_SERVICE_SECRET: "s".repeat(40),
    OUTSTAND_API_KEY: "k",
    OUTSTAND_WEBHOOK_SECRET: "w".repeat(20),
    PUBLIC_BASE_URL: "https://social.example",
  };
  it("fails clearly when mandatory configuration is absent", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ ...base, OUTSTAND_API_KEY: "" });
    } catch (e) {
      expect((e as ConfigError).message).toContain("OUTSTAND_API_KEY");
    }
  });
  it("applies defaults and production guards", () => {
    const c = loadConfig(base);
    expect(c.OUTSTAND_SCHEDULING_HORIZON_DAYS).toBe(30);
    expect(c.port).toBe(8080);
    expect(loadConfig({ ...base, PORT: "3000" }).port).toBe(3000);
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/ALLOWED_RETURN_URL_ORIGINS/);
  });
});

describe("request hashing", () => {
  it("is insensitive to key order", () => {
    expect(requestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(requestHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});
