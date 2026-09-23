import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, idem } from "./helpers.js";

const WS = "ws_rel";
const DAY = 86_400_000;
let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function draft(connectionIds: string[], extra: Record<string, unknown> = {}) {
  const res = await h.call(WS, "POST", "/v1/posts", { content: { text: "Reliable post" }, targets: connectionIds.map((connectionId) => ({ connectionId })), ...extra }, { "idempotency-key": idem() });
  expect(res.status).toBe(201);
  return res.json;
}

describe("idempotency", () => {
  it("duplicate Zeptly create returns the same post; different body with the same key conflicts", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const key = idem();
    const body = { content: { text: "Once" }, targets: [{ connectionId: c.id }] };
    const a = await h.call(WS, "POST", "/v1/posts", body, { "idempotency-key": key });
    const b = await h.call(WS, "POST", "/v1/posts", body, { "idempotency-key": key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers["idempotency-replay"]).toBe("true");
    expect(b.json.id).toBe(a.json.id);
    const c2 = await h.call(WS, "POST", "/v1/posts", { ...body, content: { text: "Twice" } }, { "idempotency-key": key });
    expect(c2.status).toBe(409);
    expect(c2.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await h.call(WS, "POST", "/v1/posts", body)).json.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("duplicate publish requests (same or different key) never create a second provider post", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    const key = idem();
    const r1 = await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": key });
    const r2 = await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": key });
    const r3 = await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": idem() });
    expect([r1.status, r2.status, r3.status]).toEqual([202, 202, 202]);
    expect(r2.headers["idempotency-replay"]).toBe("true");
    await h.drain();
    expect(h.fake.posts.size).toBe(1);
  });

  it("network timeout after upstream acceptance: the retry reuses the key and Outstand replays the same post", async () => {
    const [c] = await h.connect(WS, "facebook");
    const post = await draft([c.id]);
    // The provider accepts the create, but every response is lost (3 transport attempts).
    h.fake.fail("POST", "/posts/", { networkError: true, afterApply: true }, 3);
    const r = await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": idem() });
    expect(r.status).toBe(202);
    const pubs = await h.call(WS, "GET", `/v1/posts/${post.id}/publications`);
    expect(pubs.json.data[0].status).toBe("retry_pending");
    expect(pubs.json.data[0].lastError.code).toBe("PUBLICATION_FAILED");
    // Worker retry after backoff.
    h.clock.advance(2 * 60_000);
    await h.drain();
    const creates = h.fake.postRequests();
    expect(new Set(creates.map((x) => x.headers["idempotency-key"])).size).toBe(1);
    expect(h.fake.posts.size).toBe(1);
    const after = await h.call(WS, "GET", `/v1/posts/${post.id}/publications`);
    expect(after.json.data[0].status).toBe("accepted");
    expect(after.json.data[0].attemptCount).toBe(2);
  });

  it("ambiguous failures are not retried with an idempotency key older than 23h", async () => {
    const [c] = await h.connect(WS, "facebook");
    const post = await draft([c.id]);
    h.fake.fail("POST", "/posts/", { networkError: true }, 100);
    await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": idem() });
    h.clock.advance(24 * 3600_000);
    await h.drain();
    const got = await h.call(WS, "GET", `/v1/posts/${post.id}`);
    expect(got.json.status).toBe("failed");
    expect(got.json.targets[0].error.code).toBe("PUBLICATION_STATE_UNKNOWN");
  });

  it("provider rejection fails targets explicitly without retrying", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    h.fake.fail("POST", "/posts/", { status: 400, body: { success: false, error: "Text too long for network" } });
    const r = await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": idem() });
    expect(r.json.status).toBe("failed");
    expect(r.json.targets[0].error.code).toBe("PUBLICATION_FAILED");
    expect(r.json.targets[0].error.message).toContain("Text too long");
  });

  it("provider outage is retried with bounded attempts", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    h.fake.fail("POST", "/posts/", { status: 503 }, 1000);
    await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": idem() });
    for (let i = 0; i < 8; i++) {
      h.clock.advance(4 * 3600_000);
      await h.drain();
    }
    const pubs = await h.call(WS, "GET", `/v1/posts/${post.id}/publications`);
    expect(pubs.json.data[0].status).toBe("failed");
    expect(pubs.json.data[0].attemptCount).toBe(5);
  });
});

describe("long-range scheduling with rolling hand-off", () => {
  it("keeps a 90-day schedule locally and hands it to Outstand only inside the horizon", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    const at = new Date(h.clock.now().getTime() + 90 * DAY);
    const s = await h.call(WS, "POST", `/v1/posts/${post.id}/schedule`, { scheduledAt: at.toISOString(), timezone: "Europe/London" }, { "idempotency-key": idem() });
    expect(s.status).toBe(202);
    expect(s.json).toMatchObject({ status: "scheduled", scheduledAt: at.toISOString(), timezone: "Europe/London" });
    expect(h.fake.posts.size).toBe(0);

    h.clock.advance(50 * DAY); // 40 days out: still beyond 30d - margin
    await h.drain();
    expect(h.fake.posts.size).toBe(0);

    h.clock.advance(11 * DAY); // 29 days out: inside the window
    await h.drain();
    expect(h.fake.posts.size).toBe(1);
    const created = h.fake.postRequests()[0]?.body as { scheduledAt: string };
    expect(created.scheduledAt).toBe(at.toISOString());
    const pubs = await h.call(WS, "GET", `/v1/posts/${post.id}/publications`);
    expect(pubs.json.data[0]).toMatchObject({ status: "accepted", mode: "scheduled" });
    expect((await h.call(WS, "GET", `/v1/posts/${post.id}`)).json.targets[0].status).toBe("scheduled");

    // Hand-off happens exactly once.
    h.clock.advance(DAY);
    await h.drain();
    expect(h.fake.posts.size).toBe(1);
  });

  it("uses the configurable horizon (the adapter refuses beyond it)", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    const at = new Date(h.clock.now().getTime() + 29.5 * DAY);
    await h.call(WS, "POST", `/v1/posts/${post.id}/schedule`, { scheduledAt: at.toISOString() }, { "idempotency-key": idem() });
    // 29.5d is inside 30d but beyond 30d - 60min margin? No: 29.5d < 29d23h → handed off immediately.
    expect(h.fake.posts.size).toBe(1);
  });

  it("rescheduling a handed-off post deletes the provider copy and re-hands off", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    const soon = new Date(h.clock.now().getTime() + 2 * DAY);
    await h.call(WS, "POST", `/v1/posts/${post.id}/schedule`, { scheduledAt: soon.toISOString() }, { "idempotency-key": idem() });
    const first = h.fake.lastPost();
    expect(first).toBeDefined();
    const later = new Date(h.clock.now().getTime() + 60 * DAY);
    const r = await h.call(WS, "POST", `/v1/posts/${post.id}/schedule`, { scheduledAt: later.toISOString() }, { "idempotency-key": idem() });
    expect(r.json.status).toBe("scheduled");
    expect(h.fake.posts.get(first?.id as string)?.deleted).toBe(true);
    const pubs = await h.call(WS, "GET", `/v1/posts/${post.id}/publications`);
    expect(pubs.json.data.map((p: { status: string }) => p.status)).toEqual(["cancelled", "pending"]);
    const audits = await h.db.pool.query("select action from audit_events where action like 'schedule.%' order by created_at");
    expect(audits.rows.map((x) => x.action)).toEqual(["schedule.created", "schedule.changed"]);
  });

  it("cancel removes scheduled provider copies", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    await h.call(WS, "POST", `/v1/posts/${post.id}/schedule`, { scheduledAt: new Date(h.clock.now().getTime() + DAY).toISOString() }, { "idempotency-key": idem() });
    const cancel = await h.call(WS, "POST", `/v1/posts/${post.id}/cancel`, undefined, { "idempotency-key": idem() });
    expect(cancel.json.status).toBe("cancelled");
    expect(cancel.json.targets[0].status).toBe("cancelled");
    expect(h.fake.lastPost()?.deleted).toBe(true);
  });

  it("rejects schedules in the past", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    const r = await h.call(WS, "POST", `/v1/posts/${post.id}/schedule`, { scheduledAt: new Date(h.clock.now().getTime() - 1000).toISOString() }, { "idempotency-key": idem() });
    expect(r.json.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("webhooks and reconciliation", () => {
  async function publishOne(network = "facebook", pages = [{ name: "P1" }, { name: "P2" }]) {
    const conns = await h.connect(WS, network, pages);
    const post = await draft(conns.map((c: { id: string }) => c.id));
    await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": idem() });
    const remote = h.fake.lastPost();
    if (!remote) throw new Error("no remote");
    return { post, remote, conns };
  }

  it("duplicate webhooks are stored once and processed once", async () => {
    const { remote } = await publishOne();
    h.fake.publishAll(remote.id);
    const data = { postId: remote.id, orgId: "org_1", socialAccounts: remote.accounts.map((a) => ({ accountId: a.id, platformPostId: a.platformPostId })) };
    const ts = h.clock.now().toISOString();
    const a = await h.webhook("post.published", data, { timestamp: ts });
    const b = await h.webhook("post.published", data, { timestamp: ts });
    expect(a.json).toEqual({ accepted: true, duplicate: false });
    expect(b.json).toEqual({ accepted: true, duplicate: true });
    await h.drain();
    const rows = await h.db.pool.query("select status from webhook_events");
    expect(rows.rows).toEqual([{ status: "processed" }]);
  });

  it("post.published for one of two accounts leaves the post in progress; post.error on the other makes it partial", async () => {
    const { post, remote } = await publishOne();
    const [a1, a2] = remote.accounts;
    h.fake.setPostAccount(remote.id, a1?.id as string, { status: "published", platformPostId: "fb_1" });
    await h.webhook("post.published", { postId: remote.id, socialAccounts: [{ accountId: a1?.id, platformPostId: "fb_1" }] });
    await h.drain();
    expect((await h.call(WS, "GET", `/v1/posts/${post.id}`)).json.status).toBe("publishing");
    h.fake.setPostAccount(remote.id, a2?.id as string, { status: "failed", error: "Page restricted" });
    await h.webhook("post.error", { postId: remote.id, socialAccounts: [{ accountId: a2?.id, error: "Page restricted" }] });
    await h.drain();
    const got = await h.call(WS, "GET", `/v1/posts/${post.id}`);
    expect(got.json.status).toBe("partially_published");
    expect(got.json.targets.map((t: { status: string }) => t.status).sort()).toEqual(["failed", "published"]);
  });

  it("invalid signatures are rejected and nothing is stored", async () => {
    await publishOne();
    const res = await h.webhook("post.published", { postId: "x", socialAccounts: [] }, { secret: "not-the-secret-000000" });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    const unsigned = await h.app.inject({ method: "POST", url: "/v1/webhooks/outstand", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(unsigned.statusCode).toBe(401);
    expect((await h.db.pool.query("select count(*)::int as n from webhook_events")).rows[0].n).toBe(0);
  });

  it("webhooks for posts this service did not create cause no provider traffic", async () => {
    await publishOne();
    const before = h.fake.requests.length;
    await h.webhook("post.published", { postId: "someone-elses-post", socialAccounts: [{ accountId: "zzz" }] });
    await h.drain();
    expect(h.fake.requests.filter((r) => r.path.startsWith("/posts/someone")).length).toBe(0);
    expect(h.fake.requests.length).toBeGreaterThanOrEqual(before);
    expect((await h.db.pool.query("select status from webhook_events")).rows[0].status).toBe("ignored");
  });

  it("reconciliation recovers from missed webhooks", async () => {
    const { post, remote } = await publishOne();
    h.fake.publishAll(remote.id);
    h.clock.advance(20 * 60_000);
    await h.drain(); // periodic reconcile_publications → reconcile_publication
    await h.drain();
    expect((await h.call(WS, "GET", `/v1/posts/${post.id}`)).json.status).toBe("published");
  });

  it("account.token_expired → reauthorization_required; later publishes fail that target explicitly", async () => {
    const conns = await h.connect(WS, "instagram", [{ name: "IG" }]);
    const acct = [...h.fake.accounts.values()][0];
    const res = await h.webhook("account.token_expired", { orgId: "org_1", accountId: acct?.id, network: "instagram", username: "ig", error: "token revoked" });
    expect(res.status).toBe(200);
    await h.drain();
    const c = await h.call(WS, "GET", `/v1/connections/${conns[0].id}`);
    expect(c.json.status).toBe("reauthorization_required");
    const fb = await h.connect(WS, "facebook", [{ name: "FB" }]);
    const m = await h.call(WS, "POST", "/v1/media", { source: { type: "url", url: "https://media.zeptly-cdn.test/a.jpg" }, filename: "a.jpg", contentType: "image/jpeg" });
    await h.drain();
    const p = await h.call(WS, "POST", "/v1/posts", { content: { text: "hi", mediaIds: [m.json.id] }, targets: [{ connectionId: conns[0].id }, { connectionId: fb[0].id }] }, { "idempotency-key": idem() });
    const pub = await h.call(WS, "POST", `/v1/posts/${p.json.id}/publish`, undefined, { "idempotency-key": idem() });
    const ig = pub.json.targets.find((t: { network: string }) => t.network === "instagram");
    expect(ig.status).toBe("failed");
    expect(ig.error.code).toBe("REAUTHORIZATION_REQUIRED");
  });

  it("connection reconciliation detects inactive and removed accounts", async () => {
    const [a, b] = await h.connect(WS, "facebook", [{ name: "A" }, { name: "B" }]);
    const [x, y] = [...h.fake.accounts.values()];
    if (!x || !y) throw new Error("accounts");
    x.isActive = 0;
    h.fake.accounts.delete(y.id);
    const r = await h.call(WS, "POST", "/v1/connections/reconcile");
    expect(r.json).toMatchObject({ checked: 2, changed: 2 });
    const statuses = await Promise.all([a, b].map(async (c: { id: string }) => (await h.call(WS, "GET", `/v1/connections/${c.id}`)).json.status));
    expect(statuses.sort()).toEqual(["degraded", "reauthorization_required"]);
  });

  it("adopts an account only when tenant ref AND a recent provisioning session prove ownership", async () => {
    const init = await h.call(WS, "POST", "/v1/connections", { network: "threads", returnUrl: "https://app.zeptly.test/cb" });
    expect(init.status).toBe(201);
    const tenant = (await h.db.pool.query("select provider_tenant_ref from workspaces where external_id = $1", [WS])).rows[0].provider_tenant_ref;
    // Finalize happened at Outstand but our callback never ran.
    h.fake.addAccount({ network: "threads", tenantId: tenant, username: "lost_one" });
    h.fake.addAccount({ network: "threads", username: "someone_else" }); // no tenant ref → never adopted
    h.fake.addAccount({ network: "linkedin", tenantId: tenant, username: "no_session" }); // no session for network
    const r = await h.call(WS, "POST", "/v1/connections/reconcile");
    expect(r.json.adopted).toBe(1);
    const list = await h.call(WS, "GET", "/v1/connections");
    expect(list.json.data.map((c: { username: string }) => c.username)).toEqual(["lost_one"]);
  });
});

describe("media, metrics and conversations", () => {
  it("registers URL media, uploads it via the worker and publishes it", async () => {
    const [c] = await h.connect(WS, "instagram", [{ name: "IG" }]);
    const m = await h.call(WS, "POST", "/v1/media", { source: { type: "asset", assetRef: "asset_123", url: "https://media.zeptly-cdn.test/photo.jpg" }, filename: "photo.jpg", contentType: "image/jpeg" });
    expect(m.status).toBe(201);
    expect(m.json.status).toBe("processing");
    const early = await h.call(WS, "POST", "/v1/posts", { content: { text: "caption", mediaIds: [m.json.id] }, targets: [{ connectionId: c.id, options: { mediaType: "FEED" } }] }, { "idempotency-key": idem() });
    expect(early.status).toBe(201);
    await h.drain();
    expect((await h.call(WS, "GET", `/v1/media/${m.json.id}`)).json.status).toBe("ready");
    const pub = await h.call(WS, "POST", `/v1/posts/${early.json.id}/publish`, undefined, { "idempotency-key": idem() });
    expect(pub.json.status).toBe("publishing");
    const body = h.fake.postRequests()[0]?.body as { containers: Array<{ media: Array<{ url: string }> }>; instagram: unknown };
    expect(body.containers[0]?.media[0]?.url).toContain("cdn.outstand.test");
    expect(body.instagram).toEqual({ mediaType: "FEED" });
  });

  it("supports direct uploads without storing bytes", async () => {
    const m = await h.call(WS, "POST", "/v1/media", { source: { type: "upload" }, filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 2048 });
    expect(m.json.status).toBe("pending_upload");
    expect(m.json.uploadUrl).toContain("fake-storage");
    await h.fake.fetch(m.json.uploadUrl, { method: "PUT", body: new Uint8Array(2048) });
    const done = await h.call(WS, "POST", `/v1/media/${m.json.id}/complete`, { sizeBytes: 2048 });
    expect(done.json.status).toBe("ready");
    expect(done.json.uploadUrl).toBeUndefined();
  });

  it("validates media type and network compatibility", async () => {
    const bad = await h.call(WS, "POST", "/v1/media", { source: { type: "url", url: "https://media.zeptly-cdn.test/a.exe" }, filename: "a.exe", contentType: "application/x-msdownload" });
    expect(bad.json.error.code).toBe("MEDIA_INVALID");
    const ssrf = await h.call(WS, "POST", "/v1/media", { source: { type: "url", url: "https://169.254.169.254/latest/meta-data" }, filename: "a.jpg", contentType: "image/jpeg" });
    expect(ssrf.json.error.code).toBe("MEDIA_INVALID");
    const [ig] = await h.connect(WS, "instagram", [{ name: "IG" }]);
    const noMedia = await h.call(WS, "POST", "/v1/posts", { content: { text: "text only" }, targets: [{ connectionId: ig.id }] }, { "idempotency-key": idem() });
    expect(noMedia.status).toBe(400);
    expect(noMedia.json.error.details.problems).toContain("instagram: at least one media item is required");
  });

  it("ingests provider-reported metrics with network-scoped semantics", async () => {
    const [c] = await h.connect(WS, "linkedin");
    const post = await draft([c.id]);
    await h.call(WS, "POST", `/v1/posts/${post.id}/publish`, undefined, { "idempotency-key": idem() });
    h.fake.publishAll(h.fake.lastPost()?.id as string);
    await h.call(WS, "POST", `/v1/posts/${post.id}/reconcile`);
    const m = await h.call(WS, "POST", `/v1/posts/${post.id}/metrics/refresh`);
    expect(m.status).toBe(200);
    const names = m.json.data.map((x: { metric: string }) => x.metric).sort();
    expect(names).toEqual(["comments", "likes", "platform.video_views", "reach", "saves", "shares"]);
    expect(m.json.data[0].semantics).toMatch(/^linkedin\./);
    const q = await h.call(WS, "GET", `/v1/metrics?connectionId=${c.id}`);
    expect(q.json.data.length).toBe(6);
  });

  it("represents Instagram DMs canonically and gates other networks by capability", async () => {
    const [ig] = await h.connect(WS, "instagram", [{ name: "IG" }]);
    const [fb] = await h.connect(WS, "facebook", [{ name: "FB" }]);
    const igAcct = [...h.fake.accounts.values()].find((a) => a.network === "instagram");
    const convId = h.fake.addConversation(igAcct?.id as string);
    h.clock.advance(11 * 60_000);
    await h.drain();
    const list = await h.call(WS, "GET", `/v1/conversations?connectionId=${ig.id}`);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ network: "instagram", kind: "direct_message", participant: { displayName: "Contact One" } });
    expect(JSON.stringify(list.json)).not.toContain(convId);
    const msgs = await h.call(WS, "GET", `/v1/conversations/${list.json.data[0].id}/messages`);
    expect(msgs.json.data[0]).toMatchObject({ direction: "inbound", text: "Hello!" });
    const key = idem();
    const sent = await h.call(WS, "POST", `/v1/conversations/${list.json.data[0].id}/messages`, { text: "Thanks!" }, { "idempotency-key": key });
    expect(sent.status).toBe(201);
    expect(sent.json).toMatchObject({ direction: "outbound", status: "sent" });
    const replay = await h.call(WS, "POST", `/v1/conversations/${list.json.data[0].id}/messages`, { text: "Thanks!" }, { "idempotency-key": key });
    expect(replay.status).toBe(200);
    expect(h.fake.conversations.get(convId)?.messages.filter((x) => x.direction === "outbound")).toHaveLength(1);

    const unsupported = await h.call(WS, "GET", `/v1/conversations?connectionId=${fb.id}`);
    expect(unsupported.status).toBe(422);
    expect(unsupported.json.error).toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED", details: { network: "facebook", capability: "conversations" } });
  });

  it("ingests message.received webhooks through stored mappings only", async () => {
    await h.connect(WS, "instagram", [{ name: "IG" }]);
    const igAcct = [...h.fake.accounts.values()][0];
    await h.webhook("message.received", {
      accountId: igAcct?.id,
      conversationId: "conv_wh_1",
      conversation: { participant: { id: "p9", name: "Pat" } },
      message: { id: "m_1", direction: "inbound", text: "Price?", created_at: h.clock.now().toISOString() },
    });
    await h.webhook("message.received", { accountId: "unknown-acct", conversationId: "conv_x", message: { id: "m_2", text: "spoof" } });
    await h.drain();
    const list = await h.call(WS, "GET", "/v1/conversations");
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0].lastMessagePreview).toBe("Price?");
  });
});
