import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unwrap } from "../src/http.js";
import {
  buildCreatePostBody,
  extractPost,
  mapAccount,
  mapAccountList,
  mapAnalytics,
  mapConversation,
  mapMedia,
  mapPending,
  mapPost,
  wireUploadUrlSchema,
} from "../src/wire.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/2026-09");
const fx = (name: string): unknown => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

describe("Outstand wire contract (fixtures 2026-09)", () => {
  it("maps social accounts (snake/camel mix, numeric isActive, tenant ref)", () => {
    const data = unwrap(fx("accounts-list.json")) as unknown[];
    const accounts = data.map(mapAccount);
    expect(accounts[0]).toEqual({
      externalId: "WBh2z",
      network: "facebook",
      username: "Pigfox LLC",
      displayName: "Pigfox LLC",
      avatarUrl: "https://img.example/p.png",
      accountType: "organization",
      isActive: true,
      tenantRef: "zs_tenant",
    });
    expect(accounts[1]?.isActive).toBe(false);
  });

  it("maps pending connection pages and epoch-second expiry", () => {
    const p = mapPending(unwrap(fx("pending.json")));
    expect(p.network).toBe("facebook");
    expect(p.expiresAt?.toISOString()).toBe(new Date(1790000000 * 1000).toISOString());
    expect(p.options.map((o) => o.id)).toEqual(["1001", "1002"]);
    expect(p.options[1]?.name).toBe("Acme Store");
  });

  it("maps finalize → connectedAccounts", () => {
    const a = mapAccountList(unwrap(fx("finalize.json")));
    expect(a).toHaveLength(1);
    expect(a[0]?.externalId).toBe("GvKip");
  });

  it("maps create-post ({success, post} envelope) without lifting network_data tokens", () => {
    const post = mapPost(extractPost(fx("create-post.json")));
    expect(post.externalId).toBe("gMPex");
    expect(post.scheduledAt?.toISOString()).toBe("2026-10-14T15:45:52.000Z");
    expect(post.targets).toEqual([{ accountExternalId: "WBh2z", status: "pending" }]);
    expect(JSON.stringify(post)).not.toMatch(/SECRET|access_token|network_data/);
  });

  it("maps per-account statuses pending|published|failed|deleted from GET post ({data} envelope)", () => {
    const post = mapPost(extractPost(fx("get-post.json")));
    expect(post.targets.map((t) => t.status)).toEqual(["published", "failed", "deleted"]);
    expect(post.targets[0]).toMatchObject({ platformPostId: "urn:li:share:7", platformPostUrl: expect.stringContaining("linkedin.com") });
    expect(post.targets[1]?.error).toContain("Permissions");
    expect(JSON.stringify(post)).not.toContain("SECRET");
  });

  it("maps analytics: only reported metrics, platform-specific namespaced, non-numeric dropped", () => {
    const m = mapAnalytics(fx("analytics.json"));
    expect(m).toHaveLength(1);
    const names = m[0]?.metrics.map((x) => x.name);
    expect(names).toEqual(["likes", "comments", "shares", "reach", "saves", "platform.impressionCount"]);
    expect(names).not.toContain("views");
    expect(names).not.toContain("platform.note");
  });

  it("maps media upload and confirm", () => {
    const up = wireUploadUrlSchema.parse(unwrap(fx("media-upload.json")));
    expect(up.id).toBe("med_1");
    const media = mapMedia(unwrap(fx("media-confirm.json")), "fallback.jpg");
    expect(media).toMatchObject({ externalId: "med_1", filename: "photo.jpg", contentType: "image/jpeg", sizeBytes: 2048 });
    expect(media.expiresAt?.toISOString()).toBe("2026-09-30T10:00:00.000Z");
  });

  it("maps provisional conversation listing", () => {
    const list = unwrap(fx("conversations-list.json")) as unknown[];
    const c = mapConversation(list[0]);
    expect(c).toMatchObject({ externalId: "conv_1", accountExternalId: "IGacct", participant: { displayName: "Pat Customer", username: "pat.c" }, lastMessagePreview: "Is this in stock?" });
  });
});

describe("create-post request body", () => {
  const base = { idempotencyKey: "k", accountExternalIds: ["A1", "A2"], text: "Hi", media: [], options: {} };

  it("targets accounts by provider id under the live-verified `accounts` key", () => {
    const b = buildCreatePostBody({ ...base, network: "linkedin" });
    expect(b.accounts).toEqual(["A1", "A2"]);
    expect(b).not.toHaveProperty("socialAccountIds");
    expect(b.containers).toEqual([{ content: "Hi" }]);
    expect(b).not.toHaveProperty("scheduledAt");
  });

  it("maps only evidenced network options", () => {
    expect(buildCreatePostBody({ ...base, network: "pinterest", options: { boardId: "b1", title: "ignored" } }).pinterest).toEqual({ board_id: "b1" });
    expect(buildCreatePostBody({ ...base, network: "tiktok", options: { privacyLevel: "SELF_ONLY", bogus: 1 } }).tiktok).toEqual({ privacyLevel: "SELF_ONLY" });
    expect(buildCreatePostBody({ ...base, network: "youtube", options: { title: "T", privacyStatus: "private" } }).youtube).toEqual({ title: "T", privacyStatus: "private" });
    const li = buildCreatePostBody({ ...base, network: "linkedin", options: { anything: true } });
    expect(Object.keys(li).sort()).toEqual(["accounts", "containers"]);
  });

  it("includes media and a UTC scheduledAt", () => {
    const b = buildCreatePostBody({
      ...base,
      network: "instagram",
      scheduledAt: new Date("2026-10-01T09:00:00+02:00"),
      media: [{ externalId: "m1", url: "https://cdn/x.jpg", filename: "x.jpg" }],
    });
    expect(b.scheduledAt).toBe("2026-10-01T07:00:00.000Z");
    expect(b.containers[0]?.media).toEqual([{ id: "m1", url: "https://cdn/x.jpg", filename: "x.jpg" }]);
  });
});

describe("2026-09 Outstand additions", () => {
  it("maps Facebook Reels/Stories and Instagram AI disclosure options", () => {
    const base = { idempotencyKey: "k", accountExternalIds: ["A1"], text: "", media: [], options: {} };
    expect(buildCreatePostBody({ ...base, network: "facebook", options: { publishAsReel: true } }).facebook).toEqual({ publishAsReel: true });
    expect(buildCreatePostBody({ ...base, network: "instagram", options: { isAiGenerated: true, trialParams: {} } }).instagram).toEqual({ isAiGenerated: true });
  });

  it("passes through additional numeric metrics Outstand reports (e.g. Reels/Story metrics)", () => {
    const m = mapAnalytics({
      success: true,
      metrics_by_account: [{ social_account: { id: "A1", network: "instagram" }, metrics: { likes: 1, reels_views: 900, story_replies: 3, label: "x", "bad key!": 5, platform_specific: {} } }],
    });
    expect(m[0]?.metrics).toEqual([
      { name: "likes", value: 1 },
      { name: "reels_views", value: 900 },
      { name: "story_replies", value: 3 },
    ]);
  });
});
