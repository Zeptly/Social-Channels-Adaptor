import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, idem } from "./helpers.js";

const WS = "ws_gateway";
let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("Gateway Contract v1 surface", () => {
  it("describes the gateway (service auth, no workspace)", async () => {
    h = await createHarness();
    const res = await h.call(null, "GET", "/v1/gateway");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ gateway: "outstand", provider: "outstand", gatewayContractVersion: "1" });
    expect(res.json.capabilities.map((c: { id: string; version: string; enabled: boolean }) => `${c.id}@${c.version}:${c.enabled}`)).toEqual([
      "social.publishing@1:true",
      "social.scheduling@1:true",
      "social.analytics.basic@1:true",
      "social.direct_messages@1:true",
    ]);
    expect(res.json.channels).toContain("bluesky");
    const health = await h.call(null, "GET", "/v1/gateway/health");
    expect(health.status).toBe(200);
    expect(health.json.status).toBe("ok");
    expect(h.fake.requests.length).toBe(0);
  });

  it("reports per-workspace capability availability from active connections only", async () => {
    h = await createHarness();
    const before = await h.call(WS, "GET", "/v1/capabilities");
    expect(before.status).toBe(200);
    expect(before.json.data.every((c: { available: boolean }) => !c.available)).toBe(true);

    const [li] = await h.connect(WS, "linkedin");
    const after = await h.call(WS, "GET", "/v1/capabilities");
    const byId = Object.fromEntries(after.json.data.map((c: { id: string }) => [c.id, c]));
    expect(byId["social.publishing"]).toMatchObject({ available: true, connectionIds: [li.id] });
    expect(byId["social.direct_messages"]).toMatchObject({ available: false, channels: ["instagram"], connectionIds: [] });

    // Another workspace sees nothing of ws_gateway's connections.
    const other = await h.call("ws_other", "GET", "/v1/capabilities");
    expect(other.json.data.flatMap((c: { connectionIds: string[] }) => c.connectionIds)).toEqual([]);
  });

  it("lists provisionable channels and accepts `channel` (and legacy `network`) on connect", async () => {
    h = await createHarness();
    const ch = await h.call(WS, "GET", "/v1/connections/channels");
    expect(ch.json.data.find((c: { channel: string }) => c.channel === "bluesky")).toMatchObject({ connectionStrategy: "provider_managed", supportedStrategies: ["provider_managed", "credentials"] });
    const res = await h.call(WS, "POST", "/v1/connections", { channel: "bluesky", credentials: { handle: "brand.bsky.social", appPassword: "abcd-efgh-ijkl-mnop" } });
    expect(res.status).toBe(201);
    expect(res.json.connections[0]).toMatchObject({ channel: "bluesky", network: "bluesky", provider: "outstand" });
    expect(res.json.provisioning).toMatchObject({ channel: "bluesky", network: "bluesky" });
    const mismatch = await h.call(WS, "POST", "/v1/connections", { channel: "bluesky", network: "threads" });
    expect(mismatch.status).toBe(400);
    const filtered = await h.call(WS, "GET", "/v1/connections?channel=bluesky");
    expect(filtered.json.data).toHaveLength(1);
  });

  it("serves Social Publishing under /v1/social/publishing and flags legacy aliases as deprecated", async () => {
    h = await createHarness();
    const [c] = await h.connect(WS, "linkedin");
    const created = await h.call(WS, "POST", "/v1/social/publishing/posts", { content: { text: "canonical" }, targets: [{ connectionId: c.id }] }, { "idempotency-key": idem() });
    expect(created.status).toBe(201);
    expect(created.headers.deprecation).toBeUndefined();
    const pub = await h.call(WS, "POST", `/v1/social/publishing/posts/${created.json.id}/publish`, undefined, { "idempotency-key": idem() });
    expect(pub.status).toBe(202);
    const post = h.fake.lastPost();
    if (!post) throw new Error("no post");
    h.fake.publishAll(post.id);
    await h.webhook("post.published", { postId: post.id, socialAccounts: post.accounts.map((a) => ({ accountId: a.id, platformPostId: a.platformPostId, platformPostUrl: a.platformPostUrl })) });
    await h.drain();

    const legacy = await h.call(WS, "GET", `/v1/posts/${created.json.id}`);
    expect(legacy.json.status).toBe("published");
    expect(legacy.headers.deprecation).toBe("true");
    expect(legacy.headers.link).toBe(`</v1/social/publishing/posts/:id>; rel="successor-version"`);
    const canonical = await h.call(WS, "GET", `/v1/social/publishing/posts/${created.json.id}`);
    expect(canonical.json).toEqual(legacy.json);

    const networks = await h.call(WS, "GET", "/v1/social/publishing/networks");
    expect(networks.json.data).toHaveLength(8);
    const metrics = await h.call(WS, "GET", `/v1/social/analytics/metrics?postId=${created.json.id}`);
    expect(metrics.status).toBe(200);
    const convs = await h.call(WS, "GET", "/v1/social/direct-messages/conversations");
    expect(convs.status).toBe(200);
  });

  it("OpenAPI marks every legacy alias deprecated and exposes no adapter terminology", async () => {
    h = await createHarness();
    const doc = (await h.app.inject({ method: "GET", url: "/openapi.json" })).json();
    const legacyPaths = Object.keys(doc.paths).filter((p) => /^\/v1\/(posts|media|networks|metrics|conversations)/.test(p));
    expect(legacyPaths.length).toBeGreaterThan(10);
    for (const p of legacyPaths) for (const op of Object.values(doc.paths[p]) as Array<{ deprecated?: boolean }>) expect(op.deprecated).toBe(true);
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/adapter/i);
    expect(text).not.toMatch(/externalId|providerPostId|provider_post_id|network_data/);
  });

  it("keeps the renamed table readable (and writable) through the social_connections compatibility view", async () => {
    h = await createHarness();
    const [c] = await h.connect(WS, "threads");
    const viaView = await h.db.pool.query("select id, network from social_connections");
    expect(viaView.rows).toEqual([{ id: c.id, network: "threads" }]);
    await h.db.pool.query("update social_connections set display_name = 'renamed' where id = $1", [c.id]);
    const direct = await h.db.pool.query("select display_name from gateway_connections where id = $1", [c.id]);
    expect(direct.rows[0].display_name).toBe("renamed");
  });
});

/**
 * Architecture test A: remove Social Publishing (and every other capability)
 * and the gateway must remain coherent — identity, discovery, provisioning,
 * connection health via webhooks, and the job runtime all keep working.
 */
describe("architecture A: gateway without capability modules", () => {
  it("describes, provisions, handles account webhooks and runs jobs with no capabilities composed", async () => {
    h = await createHarness({ capabilities: [] });
    const desc = await h.call(null, "GET", "/v1/gateway");
    expect(desc.json.capabilities).toEqual([]);
    expect((await h.call(WS, "GET", "/v1/capabilities")).json.data).toEqual([]);

    // Provisioning is gateway infrastructure; connections are plain gateway connections.
    const init = await h.call(WS, "POST", "/v1/connections", { channel: "threads", returnUrl: "https://app.zeptly.test/r" });
    expect(init.status).toBe(201);
    const { callbackUrl } = h.fake.authorize(init.json.provisioning.authorizationUrl, [{ name: "Solo", type: "personal" }]);
    const cb = new URL(callbackUrl);
    expect((await h.app.inject({ method: "GET", url: cb.pathname + cb.search })).statusCode).toBe(303);
    const list = await h.call(WS, "GET", "/v1/connections");
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ channel: "threads", status: "connected" });
    expect(list.json.data[0].network).toBeUndefined();
    expect(list.json.data[0].capabilities).toBeUndefined();

    // Capability surfaces are simply absent.
    expect((await h.call(WS, "GET", "/v1/social/publishing/posts")).status).toBe(404);
    expect((await h.call(WS, "GET", "/v1/posts")).status).toBe(404);

    // Account credential expiry is handled by the gateway itself.
    const acct = [...h.fake.accounts.values()][0];
    expect((await h.webhook("account.token_expired", { accountId: acct?.id, error: "expired" })).status).toBe(200);
    // A publication event has no handler here: acknowledged, stored, ignored.
    expect((await h.webhook("post.published", { postId: "P_unknown", socialAccounts: [] })).status).toBe(200);
    await h.drain();
    const conn = await h.call(WS, "GET", `/v1/connections/${list.json.data[0].id}`);
    expect(conn.json.status).toBe("reauthorization_required");
    const events = await h.db.pool.query("select event_type, status from webhook_events order by received_at");
    expect(events.rows.map((r) => `${r.event_type}:${r.status}`)).toEqual(["account.token_expired:processed", "post.published:ignored"]);

    // Only gateway-owned periodic work is scheduled.
    const types = (await h.db.pool.query("select distinct type from jobs where type <> 'process_webhook'")).rows.map((r: { type: string }) => r.type).sort();
    expect(types).toEqual(["housekeeping", "reconcile_connections"]);
  });
});
