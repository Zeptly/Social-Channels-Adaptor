import { createHmac, randomBytes } from "node:crypto";

/**
 * Stateful in-memory fake of the Outstand REST API, wire-accurate to the
 * contract documented in docs/OUTSTAND.md (envelopes, snake/camel mix,
 * `accounts` create key, token-bearing `network_data`, silent omission of
 * unresolved account ids, 30-day scheduling horizon, Idempotency-Key replay).
 *
 * Exposed as a `fetch` implementation for tests and as an HTTP server
 * (mock-outstand-server.ts) for local development without an Outstand account.
 */

export interface FakeAccount {
  id: string;
  network: string;
  username: string;
  nickname: string;
  isActive: number;
  tenantId?: string;
  accountType: "personal" | "organization";
}

interface FakePostAccount {
  id: string;
  status: "pending" | "published" | "failed" | "deleted";
  error?: string | null;
  platformPostId?: string | null;
  platformPostUrl?: string | null;
  publishedAt?: string | null;
}

export interface FakePost {
  id: string;
  body: Record<string, unknown>;
  scheduledAt: string | null;
  publishedAt: string | null;
  accounts: FakePostAccount[];
  deleted: boolean;
}

interface PendingSession {
  token: string;
  network: string;
  tenantId?: string;
  pages: Array<{ id: string; name: string; username: string; type: "personal" | "organization" }>;
  redirectUri: string;
  finalized: boolean;
}

export type Fault = { status: number; body?: unknown; headers?: Record<string, string> } | { networkError: true; afterApply?: boolean };

export const FAKE_BASE = "https://fake.outstand.test/v1";
export const FAKE_STORAGE = "https://fake-storage.outstand.test";
export const FAKE_MEDIA_HOST = "https://media.zeptly-cdn.test";

export class FakeOutstand {
  accounts = new Map<string, FakeAccount>();
  posts = new Map<string, FakePost>();
  media = new Map<string, { id: string; filename: string; content_type: string; size?: number; uploaded: boolean }>();
  pending = new Map<string, PendingSession>();
  conversations = new Map<string, { id: string; accountId: string; participant: { id: string; name: string; username: string }; messages: Array<Record<string, unknown>> }>();
  idempotency = new Map<string, string>();
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
  faults: Array<{ match: (method: string, path: string) => boolean; fault: Fault; remaining: number }> = [];
  /** Account ids Outstand will silently drop from create-post (documented behaviour for unresolved identifiers). */
  silentlyDrop = new Set<string>();
  mediaTtlMs = 7 * 86_400_000;
  /** Test hook: force the finalize response (e.g. return an account owned by another tenant). */
  finalizeOverride: Array<Record<string, unknown>> | undefined;
  horizonDays = 30;
  now: () => Date = () => new Date();
  private seq = 0;

  readonly apiKey: string;
  constructor(apiKey = "test-outstand-key") {
    this.apiKey = apiKey;
  }

  id(prefix = ""): string {
    this.seq++;
    return `${prefix}${randomBytes(3).toString("hex")}${this.seq}`;
  }

  addAccount(a: Partial<FakeAccount> & { network: string }): FakeAccount {
    const acct: FakeAccount = {
      id: a.id ?? this.id("A"),
      network: a.network,
      username: a.username ?? `${a.network}_user_${this.seq}`,
      nickname: a.nickname ?? `${a.network} account ${this.seq}`,
      isActive: a.isActive ?? 1,
      accountType: a.accountType ?? "personal",
      ...(a.tenantId ? { tenantId: a.tenantId } : {}),
    };
    this.accounts.set(acct.id, acct);
    return acct;
  }

  fail(method: string, pathPrefix: string | RegExp, fault: Fault, times = 1): void {
    this.faults.push({
      match: (m, p) => m === method && (typeof pathPrefix === "string" ? p.startsWith(pathPrefix) : pathPrefix.test(p)),
      fault,
      remaining: times,
    });
  }

  /** Simulate the end user completing the provider-hosted authorization; returns the browser callback URL. */
  authorize(authUrl: string, pages: Array<{ name: string; username?: string; type?: "personal" | "organization" }>): { callbackUrl: string; token: string } {
    const u = new URL(authUrl);
    const token = u.searchParams.get("state_token");
    const s = token ? this.pending.get(token) : undefined;
    if (!s) throw new Error("unknown auth url");
    s.pages = pages.map((p, i) => ({ id: `page_${i}_${this.seq}`, name: p.name, username: p.username ?? p.name.toLowerCase().replace(/\s+/g, "_"), type: p.type ?? "organization" }));
    const cb = new URL(s.redirectUri);
    cb.searchParams.set("session", s.token);
    return { callbackUrl: cb.toString(), token: s.token };
  }

  setPostAccount(postId: string, accountId: string, patch: Partial<FakePostAccount>): void {
    const p = this.posts.get(postId);
    const a = p?.accounts.find((x) => x.id === accountId);
    if (!p || !a) throw new Error("unknown post/account");
    Object.assign(a, patch);
    if (patch.status === "published" && !p.publishedAt) p.publishedAt = patch.publishedAt ?? this.now().toISOString();
  }

  /** Mark every pending account of a post published (what Outstand does at publish time). */
  publishAll(postId: string): void {
    const p = this.posts.get(postId);
    if (!p) throw new Error("unknown post");
    for (const a of p.accounts) {
      if (a.status === "pending") this.setPostAccount(postId, a.id, { status: "published", platformPostId: `plat_${randomBytes(4).toString("hex")}`, platformPostUrl: `https://social.example/p/${randomBytes(4).toString("hex")}` });
    }
  }

  signWebhook(secret: string, event: string, data: Record<string, unknown>, timestamp = this.now().toISOString()): { body: string; signature: string } {
    const body = JSON.stringify({ event, timestamp, data });
    return { body, signature: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` };
  }

  lastPost(): FakePost | undefined {
    return [...this.posts.values()].at(-1);
  }

  postRequests(): Array<{ headers: Record<string, string>; body: unknown }> {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/posts/");
  }

  /* ------------------------------------------------------------------ */

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.origin === FAKE_STORAGE) return this.storage(method, url, init);
    if (url.origin === FAKE_MEDIA_HOST) return this.mediaSource(url);
    if (!url.href.startsWith(FAKE_BASE)) return new Response("not found", { status: 404 });
    const path = url.pathname.replace(/^\/v1/, "");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    this.requests.push({ method, path: path + (url.search || ""), headers, body });
    if (headers.authorization !== `Bearer ${this.apiKey}`) return json(401, { success: false, error: "Unauthorized" });

    const faultIdx = this.faults.findIndex((f) => f.match(method, path) && f.remaining > 0);
    const fault = faultIdx >= 0 ? this.faults[faultIdx] : undefined;
    if (fault) {
      fault.remaining--;
      if (fault.remaining <= 0) this.faults.splice(faultIdx, 1);
      if ("networkError" in fault.fault) {
        if (fault.fault.afterApply) this.route(method, path, url, headers, body); // upstream accepted, response lost
        throw new TypeError("fetch failed");
      }
      return json(fault.fault.status, fault.fault.body ?? { success: false, error: "Injected failure" }, fault.fault.headers);
    }
    return this.route(method, path, url, headers, body);
  };

  private route(method: string, path: string, url: URL, headers: Record<string, string>, body: unknown): Response {
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/social-accounts") {
      const tenant = url.searchParams.get("tenantId");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = [...this.accounts.values()].filter((a) => !tenant || a.tenantId === tenant);
      return json(200, { success: true, data: all.slice(offset, offset + limit).map(wireAccount) });
    }
    if (method === "DELETE" && (m = /^\/social-accounts\/([^/]+)$/.exec(path))) {
      if (!this.accounts.delete(decodeURIComponent(m[1] as string))) return json(404, { success: false, error: "Not found" });
      return json(200, { success: true });
    }
    if (method === "POST" && (m = /^\/social-networks\/([^/]+)\/auth-url$/.exec(path))) {
      const network = m[1] as string;
      if (["x", "reddit", "google_business", "vimeo"].includes(network)) return json(400, { success: false, error: "BYOK required" });
      const token = `sess_${randomBytes(12).toString("hex")}`;
      this.pending.set(token, { token, network, tenantId: b.tenant_id as string, pages: [], redirectUri: b.redirect_uri as string, finalized: false });
      return json(200, { success: true, data: { auth_url: `https://fake.outstand.test/authorize?network=${network}&state_token=${token}` } });
    }
    if (method === "POST" && path === "/social-accounts/bluesky") {
      if (typeof b.app_password !== "string" || (b.app_password as string).length < 8) return json(400, { success: false, error: "Invalid app password" });
      const acct = this.addAccount({ network: "bluesky", username: b.handle as string, nickname: b.handle as string, tenantId: b.tenant_id as string });
      return json(200, { success: true, data: wireAccount(acct) });
    }
    if (method === "GET" && (m = /^\/social-accounts\/pending\/([^/]+)$/.exec(path))) {
      const s = this.pending.get(decodeURIComponent(m[1] as string));
      if (!s || s.finalized) return json(404, { success: false, error: "Session not found" });
      return json(200, {
        success: true,
        data: { network: s.network, expiresAt: Math.floor(this.now().getTime() / 1000) + 900, availablePages: s.pages.map((p) => ({ ...p, profilePictureUrl: `https://img.test/${p.id}.png` })) },
      });
    }
    if (method === "POST" && (m = /^\/social-accounts\/pending\/([^/]+)\/finalize$/.exec(path))) {
      const s = this.pending.get(decodeURIComponent(m[1] as string));
      if (!s || s.finalized) return json(404, { success: false, error: "Session not found" });
      if (this.finalizeOverride) {
        s.finalized = true;
        return json(200, { success: true, data: { connectedAccounts: this.finalizeOverride } });
      }
      const ids = (b.selectedPageIds as string[]) ?? [];
      const chosen = s.pages.length ? s.pages.filter((p) => ids.includes(p.id)) : [{ id: "self", name: `${s.network} user`, username: `${s.network}_self`, type: "personal" as const }];
      s.finalized = true;
      const created = chosen.map((p) => this.addAccount({ network: s.network, username: p.username, nickname: p.name, accountType: p.type, ...(s.tenantId ? { tenantId: s.tenantId } : {}) }));
      return json(200, { success: true, data: { connectedAccounts: created.map(wireAccount) } });
    }
    if (method === "POST" && path === "/media/upload") {
      const id = this.id("M");
      this.media.set(id, { id, filename: b.filename as string, content_type: b.content_type as string, uploaded: false });
      return json(200, { success: true, data: { id, upload_url: `${FAKE_STORAGE}/upload/${id}?X-Amz-Signature=secretsig`, expires_in: 900 } });
    }
    if (method === "POST" && (m = /^\/media\/([^/]+)\/confirm$/.exec(path))) {
      const md = this.media.get(m[1] as string);
      if (!md?.uploaded) return json(400, { success: false, error: "Upload not found" });
      md.size = (b.size as number) ?? md.size;
      return json(200, {
        success: true,
        data: {
          id: md.id,
          filename: md.filename,
          url: `https://cdn.outstand.test/${md.id}/${md.filename}`,
          content_type: md.content_type,
          size: md.size,
          status: "active",
          created_at: this.now().toISOString(),
          expires_at: new Date(this.now().getTime() + this.mediaTtlMs).toISOString(),
        },
      });
    }
    if (method === "POST" && path === "/posts/") {
      const key = headers["idempotency-key"];
      if (key && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return json(400, { success: false, error: "VALIDATION_ERROR", message: "Idempotency-Key must be a UUID v4" });
      if (key && this.idempotency.has(key)) {
        const existing = this.posts.get(this.idempotency.get(key) as string) as FakePost;
        return json(200, { success: true, post: wirePost(existing, this.accounts) }, { "idempotency-replay": "true" });
      }
      if (!Array.isArray(b.accounts)) return json(400, { success: false, error: "Validation failed", details: { path: ["accounts"], message: "Required" } });
      if (b.scheduledAt) {
        const t = new Date(b.scheduledAt as string).getTime();
        if (t > this.now().getTime() + this.horizonDays * 86_400_000) return json(400, { success: false, error: "scheduledAt cannot be more than 30 days in the future" });
      }
      const resolved = (b.accounts as string[]).filter((id) => this.accounts.has(id) && !this.silentlyDrop.has(id));
      if (resolved.length === 0) return json(400, { success: false, error: "No valid social accounts" });
      const post: FakePost = {
        id: this.id("P"),
        body: b,
        scheduledAt: (b.scheduledAt as string) ?? null,
        publishedAt: null,
        accounts: resolved.map((id) => ({ id, status: "pending" })),
        deleted: false,
      };
      this.posts.set(post.id, post);
      if (key) this.idempotency.set(key, post.id);
      return json(200, { success: true, post: wirePost(post, this.accounts) });
    }
    if ((m = /^\/posts\/([^/]+)\/analytics$/.exec(path)) && method === "GET") {
      const p = this.posts.get(m[1] as string);
      if (!p) return json(404, { success: false, error: "Not found" });
      const published = p.accounts.filter((a) => a.status === "published");
      return json(200, {
        success: true,
        post: { id: p.id, publishedAt: p.publishedAt, createdAt: this.now().toISOString() },
        metrics_by_account: published.map((a, i) => ({
          social_account: { id: a.id, nickname: this.accounts.get(a.id)?.nickname ?? "", network: this.accounts.get(a.id)?.network ?? "", username: "" },
          platform_post_id: a.platformPostId,
          published_at: a.publishedAt,
          metrics: { likes: 10 + i, comments: 2, shares: 1, reach: 100, saves: 0, platform_specific: { video_views: 42, label: "x" } },
        })),
        aggregated_metrics: { total_likes: 10, total_comments: 2, total_shares: 1, total_views: 0, total_impressions: 0, total_reach: 100, average_engagement_rate: 0.1 },
      });
    }
    if ((m = /^\/posts\/([^/]+)$/.exec(path))) {
      const p = this.posts.get(m[1] as string);
      if (!p || (p.deleted && method === "DELETE")) return json(404, { success: false, error: "Not found" });
      if (method === "GET") return json(200, { success: true, data: wirePost(p, this.accounts) });
      if (method === "PATCH") {
        if (p.deleted || p.accounts.some((a) => a.status !== "pending")) return json(400, { success: false, error: "Only unpublished posts can be updated" });
        if (b.accounts !== undefined) return json(400, { success: false, error: "accounts cannot be changed" });
        if (b.scheduledAt) {
          const t = new Date(b.scheduledAt as string).getTime();
          if (t > this.now().getTime() + this.horizonDays * 86_400_000) return json(400, { success: false, error: "scheduledAt cannot be more than 30 days in the future" });
          p.scheduledAt = b.scheduledAt as string;
        }
        p.body = { ...p.body, ...b };
        return json(200, { success: true, post: wirePost(p, this.accounts) });
      }
      if (method === "DELETE") {
        p.deleted = true;
        for (const a of p.accounts) if (a.status === "pending") a.status = "deleted";
        return json(200, { success: true });
      }
    }
    if (method === "GET" && path === "/conversations") {
      const acct = url.searchParams.get("social_account_id");
      const list = [...this.conversations.values()].filter((c) => c.accountId === acct);
      return json(200, {
        success: true,
        data: list.map((c) => ({ id: c.id, social_account_id: c.accountId, participant: c.participant, last_message_at: c.messages.at(-1)?.created_at ?? null, last_message: { text: c.messages.at(-1)?.text ?? null } })),
      });
    }
    if ((m = /^\/conversations\/([^/]+)\/messages$/.exec(path))) {
      const c = this.conversations.get(m[1] as string);
      if (!c) return json(404, { success: false, error: "Not found" });
      if (method === "GET") return json(200, { success: true, data: [...c.messages].reverse() });
      if (method === "POST") {
        const key = headers["idempotency-key"];
        const prior = key ? c.messages.find((x) => x._key === key) : undefined;
        if (prior) return json(200, { success: true, data: strip(prior) }, { "idempotency-replay": "true" });
        const msg = { id: this.id("MSG"), conversation_id: c.id, direction: "outbound", status: "sent", text: b.text, created_at: this.now().toISOString(), _key: key };
        c.messages.push(msg);
        return json(200, { success: true, data: strip(msg) });
      }
    }
    return json(404, { success: false, error: `No fake route for ${method} ${path}` });
  }

  addConversation(accountId: string, participant = { id: "ig_contact_1", name: "Contact One", username: "contact.one" }): string {
    const id = this.id("C");
    this.conversations.set(id, {
      id,
      accountId,
      participant,
      messages: [{ id: this.id("MSG"), conversation_id: id, direction: "inbound", status: "received", text: "Hello!", created_at: this.now().toISOString() }],
    });
    return id;
  }

  private storage(method: string, url: URL, init?: RequestInit): Response {
    const m = /^\/upload\/([^/]+)$/.exec(url.pathname);
    const md = m ? this.media.get(m[1] as string) : undefined;
    if (method !== "PUT" || !md) return new Response("bad", { status: 400 });
    md.uploaded = true;
    const b = init?.body;
    md.size = b instanceof Uint8Array ? b.byteLength : typeof b === "string" ? b.length : md.size;
    return new Response(null, { status: 200 });
  }

  private mediaSource(url: URL): Response {
    if (url.pathname.includes("missing")) return new Response("nope", { status: 404 });
    if (url.pathname.includes("redirect")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    const bytes = new Uint8Array(url.pathname.includes("huge") ? 64 : 2048).fill(7);
    const type = url.pathname.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
    return new Response(bytes, { status: 200, headers: { "content-type": type, "content-length": url.pathname.includes("huge") ? String(50 * 1024 ** 3) : String(bytes.byteLength) } });
  }
}

function strip(m: Record<string, unknown>): Record<string, unknown> {
  const { _key, ...rest } = m;
  void _key;
  return rest;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function wireAccount(a: FakeAccount): Record<string, unknown> {
  return {
    id: a.id,
    orgId: "org_1",
    nickname: a.nickname,
    network: a.network,
    username: a.username,
    profile_picture_url: `https://img.test/avatar-${a.username}.png`,
    network_unique_id: `nu_${a.id}`,
    accountType: a.accountType,
    isActive: a.isActive,
    ...(a.tenantId ? { tenantId: a.tenantId } : {}),
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function wirePost(p: FakePost, accounts: Map<string, FakeAccount>): Record<string, unknown> {
  return {
    id: p.id,
    orgId: "org_1",
    publishedAt: p.publishedAt,
    scheduledAt: p.scheduledAt,
    isDraft: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    containers: p.body.containers,
    socialAccounts: p.accounts.map((a) => ({
      id: a.id,
      nickname: accounts.get(a.id)?.nickname ?? null,
      network: accounts.get(a.id)?.network ?? null,
      username: accounts.get(a.id)?.username ?? null,
      status: a.status,
      error: a.error ?? null,
      platformPostId: a.platformPostId ?? null,
      platformPostUrl: a.platformPostUrl ?? null,
      publishedAt: a.publishedAt ?? null,
      // Outstand embeds per-network OAuth tokens here; the adapter must never lift them.
      network_data: { access_token: "LEAKY-ACCESS-TOKEN-123456", refresh_token: "LEAKY-REFRESH-TOKEN-654321" },
    })),
  };
}
