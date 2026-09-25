import { TEST_OUTSTAND_KEY, TEST_SERVICE_SECRET, TEST_WEBHOOK_SECRET } from "@zeptly-gateway/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signRequest } from "@zeptly-gateway/gateway-core";
import { createHarness, type Harness, idem } from "./helpers.js";

const A = "ws_tenant_a";
const B = "ws_tenant_b";
let h: Harness;
const responses: string[] = [];

beforeEach(async () => {
  h = await createHarness();
  responses.length = 0;
  const call = h.call;
  h.call = async (...args) => {
    const r = await call(...args);
    responses.push(JSON.stringify(r.json));
    return r;
  };
});
afterEach(async () => {
  await h.close();
});

/** B's full estate: connection, published post, Instagram DM, media, metrics. */
async function seedB() {
  const [bConn] = await h.connect(B, "instagram", [{ name: "B IG" }]);
  const bMedia = await h.call(B, "POST", "/v1/media", { source: { type: "url", url: "https://media.zeptly-cdn.test/b.jpg" }, filename: "b.jpg", contentType: "image/jpeg" });
  await h.drain();
  const bPost = await h.call(B, "POST", "/v1/posts", { content: { text: "B secret launch", mediaIds: [bMedia.json.id] }, targets: [{ connectionId: bConn.id }] }, { "idempotency-key": idem() });
  await h.call(B, "POST", `/v1/posts/${bPost.json.id}/publish`, undefined, { "idempotency-key": idem() });
  h.fake.publishAll(h.fake.lastPost()?.id as string);
  await h.call(B, "POST", `/v1/posts/${bPost.json.id}/reconcile`);
  await h.call(B, "POST", `/v1/posts/${bPost.json.id}/metrics/refresh`);
  const bAcct = [...h.fake.accounts.values()].find((a) => a.network === "instagram");
  h.fake.addConversation(bAcct?.id as string);
  h.clock.advance(11 * 60_000);
  await h.drain();
  const conv = (await h.call(B, "GET", "/v1/conversations")).json.data[0];
  return { bConn, bPost: bPost.json, bMedia: bMedia.json, conv, bAcct };
}

describe("workspace isolation", () => {
  it("Workspace A cannot use Workspace B's connection", async () => {
    const { bConn } = await seedB();
    await h.connect(A, "linkedin");
    const r = await h.call(A, "POST", "/v1/posts", { content: { text: "hijack" }, targets: [{ connectionId: bConn.id }] }, { "idempotency-key": idem() });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("CONNECTION_NOT_FOUND");
    expect((await h.call(A, "GET", `/v1/connections/${bConn.id}`)).status).toBe(404);
    expect((await h.call(A, "DELETE", `/v1/connections/${bConn.id}`)).status).toBe(404);
    expect((await h.call(A, "POST", `/v1/connections/${bConn.id}/reconnect`, { returnUrl: "https://app.zeptly.test/cb" })).status).toBe(404);
    expect((await h.call(A, "GET", "/v1/connections")).json.data.every((c: { workspaceId: string }) => c.workspaceId === A)).toBe(true);
  });

  it("Workspace A cannot inspect or modify Workspace B's posts, schedules and publications", async () => {
    const { bPost } = await seedB();
    for (const [method, url] of [
      ["GET", `/v1/posts/${bPost.id}`],
      ["GET", `/v1/posts/${bPost.id}/publications`],
      ["POST", `/v1/posts/${bPost.id}/reconcile`],
      ["POST", `/v1/posts/${bPost.id}/metrics/refresh`],
    ] as const) {
      const r = await h.call(A, method, url);
      expect(r.status, url).toBe(404);
    }
    for (const cmd of ["publish", "cancel"]) {
      const r = await h.call(A, "POST", `/v1/posts/${bPost.id}/${cmd}`, undefined, { "idempotency-key": idem() });
      expect(r.status, cmd).toBe(404);
    }
    const s = await h.call(A, "POST", `/v1/posts/${bPost.id}/schedule`, { scheduledAt: new Date(h.clock.now().getTime() + 86_400_000).toISOString() }, { "idempotency-key": idem() });
    expect(s.status).toBe(404);
    expect((await h.call(A, "GET", "/v1/posts")).json.data).toEqual([]);
  });

  it("Workspace A cannot inspect Workspace B's conversations, messages, media or metrics", async () => {
    const { conv, bMedia, bPost, bConn } = await seedB();
    expect(conv).toBeDefined();
    expect((await h.call(A, "GET", "/v1/conversations")).json.data).toEqual([]);
    expect((await h.call(A, "GET", `/v1/conversations/${conv.id}`)).status).toBe(404);
    expect((await h.call(A, "GET", `/v1/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await h.call(A, "POST", `/v1/conversations/${conv.id}/messages`, { text: "spoof" }, { "idempotency-key": idem() })).status).toBe(404);
    expect((await h.call(A, "GET", `/v1/conversations?connectionId=${bConn.id}`)).status).toBe(404);
    expect((await h.call(A, "GET", `/v1/media/${bMedia.id}`)).status).toBe(404);
    expect((await h.call(A, "GET", `/v1/metrics?postId=${bPost.id}`)).json.data).toEqual([]);
    expect((await h.call(A, "GET", `/v1/metrics?connectionId=${bConn.id}`)).status).toBe(404);
    // A cannot attach B's media to its own post.
    const [aConn] = await h.connect(A, "instagram", [{ name: "A IG" }]);
    const r = await h.call(A, "POST", "/v1/posts", { content: { text: "x", mediaIds: [bMedia.id] }, targets: [{ connectionId: aConn.id }] }, { "idempotency-key": idem() });
    expect(r.json.error.code).toBe("MEDIA_NOT_FOUND");
  });

  it("provider identifiers cannot bypass workspace isolation", async () => {
    const { bAcct } = await seedB();
    await h.connect(A, "linkedin");
    // Supplying a raw provider account id as a connection id does nothing.
    const r = await h.call(A, "POST", "/v1/posts", { content: { text: "x" }, targets: [{ connectionId: bAcct?.id }] }, { "idempotency-key": idem() });
    expect(r.status).toBe(400);
    // A provider account already owned by B can never be adopted by A, even if A's flow returns it.
    const init = await h.call(A, "POST", "/v1/connections", { network: "instagram", returnUrl: "https://app.zeptly.test/cb" });
    const pend = h.fake.authorize(init.json.provisioning.authorizationUrl, [{ name: "stolen" }]);
    h.fake.finalizeOverride = [{ id: bAcct?.id, network: "instagram", username: "b", isActive: 1 }];
    const cb = new URL(pend.callbackUrl);
    const res = await h.app.inject({ method: "GET", url: cb.pathname + cb.search });
    expect(res.headers.location).toContain("status=failed");
    expect((await h.call(A, "GET", "/v1/connections?network=instagram")).json.data).toEqual([]);
    const conflict = await h.db.pool.query("select count(*)::int as n from audit_events where action = 'connection.ownership_conflict'");
    expect(conflict.rows[0].n).toBe(1);
  });

  it("webhooks for B's accounts never touch A's resources", async () => {
    const { bAcct } = await seedB();
    const [aConn] = await h.connect(A, "linkedin");
    await h.webhook("account.token_expired", { accountId: bAcct?.id, error: "expired" });
    await h.drain();
    expect((await h.call(A, "GET", `/v1/connections/${aConn.id}`)).json.status).toBe("connected");
    const bConns = (await h.call(B, "GET", "/v1/connections")).json.data;
    expect(bConns[0].status).toBe("reauthorization_required");
  });
});

describe("authentication", () => {
  it("rejects unsigned, mis-signed and cross-workspace-replayed requests", async () => {
    expect((await h.app.inject({ method: "GET", url: "/v1/connections", headers: { "x-zeptly-workspace-id": A } })).statusCode).toBe(401);
    const ts = String(Math.floor(h.clock.now().getTime() / 1000));
    const sig = signRequest(TEST_SERVICE_SECRET, { timestamp: ts, method: "GET", url: "/v1/connections", workspaceId: A, caller: "zeptly-app", agent: "", body: undefined });
    const ok = await h.app.inject({ method: "GET", url: "/v1/connections", headers: { "x-zeptly-caller": "zeptly-app", "x-zeptly-timestamp": ts, "x-zeptly-workspace-id": A, "x-zeptly-signature": sig } });
    expect(ok.statusCode).toBe(200);
    const replay = await h.app.inject({ method: "GET", url: "/v1/connections", headers: { "x-zeptly-caller": "zeptly-app", "x-zeptly-timestamp": ts, "x-zeptly-workspace-id": B, "x-zeptly-signature": sig } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("AUTHENTICATION_FAILED");
    const badSecret = signRequest("x".repeat(40), { timestamp: ts, method: "GET", url: "/v1/connections", workspaceId: A, caller: "zeptly-app", agent: "", body: undefined });
    expect((await h.app.inject({ method: "GET", url: "/v1/connections", headers: { "x-zeptly-caller": "zeptly-app", "x-zeptly-timestamp": ts, "x-zeptly-workspace-id": A, "x-zeptly-signature": badSecret } })).statusCode).toBe(401);
  });

  it("workspace routes require a workspace; admin routes are service-authenticated", async () => {
    const r = await h.call(null, "GET", "/v1/connections");
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("WORKSPACE_FORBIDDEN");
    expect((await h.call(null, "GET", "/v1/admin/jobs")).status).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/v1/admin/jobs" })).statusCode).toBe(401);
    expect((await h.call("bad workspace id!", "GET", "/v1/connections")).json.error.code).toBe("WORKSPACE_FORBIDDEN");
  });

  it("health endpoints and the OpenAPI document are public; nothing else is", async () => {
    expect((await h.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/openapi.json" })).statusCode).toBe(200);
    for (const url of ["/v1/networks", "/v1/posts", "/v1/conversations", "/v1/metrics?postId=x"]) {
      expect((await h.app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});

describe("secret handling", () => {
  it("never serializes provider credentials, tokens or provider ids into API responses", async () => {
    await seedB();
    await h.call(B, "POST", "/v1/connections", { network: "bluesky", credentials: { handle: "b.bsky.social", appPassword: "app-pass-word-123" } });
    await h.call(B, "GET", "/v1/connections");
    await h.call(B, "GET", "/v1/posts");
    await h.call(null, "GET", "/v1/admin/webhook-events");
    const all = responses.join("\n");
    for (const secret of [TEST_OUTSTAND_KEY, TEST_WEBHOOK_SECRET, TEST_SERVICE_SECRET, "LEAKY-ACCESS-TOKEN", "LEAKY-REFRESH-TOKEN", "app-pass-word-123", "X-Amz-Signature=secretsig"]) {
      expect(all).not.toContain(secret);
    }
    for (const acct of h.fake.accounts.values()) expect(all).not.toContain(`"${acct.id}"`);
    for (const post of h.fake.posts.values()) expect(all).not.toContain(post.id);
  });

  it("stores no tokens or credentials in the database", async () => {
    await seedB();
    await h.call(B, "POST", "/v1/connections", { network: "bluesky", credentials: { handle: "b.bsky.social", appPassword: "app-pass-word-123" } });
    const tables = (await h.db.pool.query("select tablename from pg_tables where schemaname='public'")).rows.map((r) => r.tablename);
    for (const t of tables) {
      const dump = (await h.db.pool.query(`select coalesce(json_agg(x)::text, '') as j from "${t}" x`)).rows[0].j as string;
      for (const s of [TEST_OUTSTAND_KEY, "LEAKY-ACCESS-TOKEN", "app-pass-word-123", TEST_WEBHOOK_SECRET]) expect(dump, t).not.toContain(s);
    }
  });

  it("records audit events with the calling service and agent", async () => {
    await h.call(A, "POST", "/v1/connections", { network: "linkedin", returnUrl: "https://app.zeptly.test/cb" }, { "x-zeptly-agent": "agent:publisher-7" });
    const rows = (await h.db.pool.query("select action, actor_service, actor_agent, request_id from audit_events")).rows;
    expect(rows[0]).toMatchObject({ action: "connection.initiated", actor_service: "zeptly-app", actor_agent: "agent:publisher-7" });
    expect(rows[0].request_id).toBeTruthy();
  });
});
