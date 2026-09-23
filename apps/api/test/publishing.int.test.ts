import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, idem } from "./helpers.js";

const WS = "ws_alpha";
let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function createPost(connIds: string[], text = "Hello from Zeptly", key = idem()) {
  return h.call(WS, "POST", "/v1/posts", { content: { text }, targets: connIds.map((connectionId) => ({ connectionId })) }, { "idempotency-key": key });
}

describe("connection lifecycle", () => {
  it("provisions via provider-hosted OAuth and returns canonical connections without provider ids", async () => {
    const conns = await h.connect(WS, "linkedin", [{ name: "Acme Ltd", type: "organization" }, { name: "Jane Doe", type: "personal" }]);
    expect(conns).toHaveLength(2);
    expect(conns[0]).toMatchObject({ network: "linkedin", status: "connected", provider: "outstand", workspaceId: WS });
    expect(conns[0].capabilities).toMatchObject({ publish: true, conversations: false });
    const serialized = JSON.stringify(conns);
    for (const acct of h.fake.accounts.values()) expect(serialized).not.toContain(acct.id);
    // Accounts were created at the provider with our opaque tenant ref, never the Zeptly workspace id.
    for (const acct of h.fake.accounts.values()) {
      expect(acct.tenantId).toMatch(/^zs_[0-9a-f]{32}$/);
      expect(acct.tenantId).not.toContain(WS);
    }
  });

  it("auto-finalizes single-account networks and exposes provisioning state", async () => {
    const conns = await h.connect(WS, "threads", [{ name: "Only me", type: "personal" }]);
    expect(conns).toHaveLength(1);
    expect(conns[0].status).toBe("connected");
  });

  it("connects Bluesky with credentials without persisting them", async () => {
    const res = await h.call(WS, "POST", "/v1/connections", { network: "bluesky", credentials: { handle: "brand.bsky.social", appPassword: "abcd-efgh-ijkl-mnop" } });
    expect(res.status).toBe(201);
    expect(res.json.connections[0]).toMatchObject({ network: "bluesky", status: "connected", username: "brand.bsky.social" });
    expect(res.json.provisioning.strategy).toBe("credentials");
    const dump = await h.db.pool.query("select row_to_json(t)::text as j from provisioning_sessions t");
    expect(dump.rows.map((r) => r.j).join()).not.toContain("abcd-efgh-ijkl-mnop");
    const audit = await h.db.pool.query("select metadata::text from audit_events");
    expect(audit.rows.map((r) => r.metadata).join()).not.toContain("abcd-efgh-ijkl-mnop");
  });

  it("rejects returnUrl origins that are not allow-listed (open redirect)", async () => {
    const res = await h.call(WS, "POST", "/v1/connections", { network: "facebook", returnUrl: "https://evil.example/cb" });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects BYOK networks at the contract boundary", async () => {
    const res = await h.call(WS, "POST", "/v1/connections", { network: "x", returnUrl: "https://app.zeptly.test/cb" });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("VALIDATION_ERROR");
  });

  it("the callback state token is single-use", async () => {
    const init = await h.call(WS, "POST", "/v1/connections", { network: "facebook", returnUrl: "https://app.zeptly.test/cb" });
    const { callbackUrl } = h.fake.authorize(init.json.provisioning.authorizationUrl, [{ name: "Page A" }, { name: "Page B" }]);
    const u = new URL(callbackUrl);
    const first = await h.app.inject({ method: "GET", url: u.pathname + u.search });
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toContain("status=awaiting_selection");
    const again = await h.app.inject({ method: "GET", url: u.pathname + u.search });
    expect(again.headers.location).toContain("status=awaiting_selection");
    const bogus = await h.app.inject({ method: "GET", url: "/v1/connect/callback/not-a-real-state-token-xxxxxxxx?session=abc" });
    expect(bogus.statusCode).toBe(404);
  });

  it("disconnects and reports reconnect flow", async () => {
    const [c] = await h.connect(WS, "facebook");
    const del = await h.call(WS, "DELETE", `/v1/connections/${c.id}`);
    expect(del.status).toBe(200);
    expect(del.json.status).toBe("disconnected");
    expect(h.fake.accounts.size).toBe(0);
    const rc = await h.call(WS, "POST", `/v1/connections/${c.id}/reconnect`, { returnUrl: "https://app.zeptly.test/cb" });
    expect(rc.status).toBe(201);
    expect(rc.json.provisioning.reconnectConnectionId).toBe(c.id);
  });
});

describe("publishing", () => {
  it("publishes to multiple accounts with provider account ids and a persisted UUID idempotency key", async () => {
    const conns = await h.connect(WS, "linkedin", [{ name: "A" }, { name: "B" }]);
    const created = await createPost(conns.map((c: { id: string }) => c.id));
    expect(created.status).toBe(201);
    expect(created.json.status).toBe("draft");
    const pub = await h.call(WS, "POST", `/v1/posts/${created.json.id}/publish`, undefined, { "idempotency-key": idem() });
    expect(pub.status).toBe(202);
    expect(pub.json.status).toBe("publishing");
    const req = h.fake.postRequests()[0];
    expect(req?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect((req?.body as { accounts: string[] }).accounts.sort()).toEqual([...h.fake.accounts.keys()].sort());

    const post = h.fake.lastPost();
    if (!post) throw new Error("no post");
    h.fake.publishAll(post.id);
    const wh = await h.webhook("post.published", {
      postId: post.id,
      orgId: "org_1",
      socialAccounts: post.accounts.map((a) => ({ accountId: a.id, platformPostId: a.platformPostId, platformPostUrl: a.platformPostUrl })),
    });
    expect(wh.status).toBe(200);
    await h.drain();
    const got = await h.call(WS, "GET", `/v1/posts/${created.json.id}`);
    expect(got.json.status).toBe("published");
    expect(got.json.targets.every((t: { status: string; platformPostUrl?: string }) => t.status === "published" && t.platformPostUrl)).toBe(true);
    expect(JSON.stringify(got.json)).not.toContain("LEAKY");
  });

  it("marks a silently dropped destination as an explicit target failure (partially_published)", async () => {
    const conns = await h.connect(WS, "facebook", [{ name: "Page A" }, { name: "Page B" }]);
    const [dropped] = [...h.fake.accounts.keys()];
    h.fake.silentlyDrop.add(dropped as string);
    const created = await createPost(conns.map((c: { id: string }) => c.id));
    const pub = await h.call(WS, "POST", `/v1/posts/${created.json.id}/publish`, undefined, { "idempotency-key": idem() });
    const failed = pub.json.targets.filter((t: { status: string }) => t.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error.code).toBe("TARGET_DROPPED_BY_PROVIDER");
    const post = h.fake.lastPost();
    if (!post) throw new Error("no post");
    h.fake.publishAll(post.id);
    await h.call(WS, "POST", `/v1/posts/${created.json.id}/reconcile`);
    const got = await h.call(WS, "GET", `/v1/posts/${created.json.id}`);
    expect(got.json.status).toBe("partially_published");
  });
});
