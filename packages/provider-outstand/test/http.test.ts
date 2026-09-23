import { ProviderError } from "@zeptly-social/provider-contract";
import { describe, expect, it } from "vitest";
import { OutstandProvider } from "../src/provider.js";

const KEY = "test_fake_outstand_key_0123456789";

function provider(responder: (req: { url: string; init: RequestInit; n: number }) => Response | Promise<Response>) {
  let n = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    n++;
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return responder({ url, init: init ?? {}, n });
  };
  const p = new OutstandProvider({ apiKey: KEY, webhookSecret: "whsec_0123456789abcdef", baseUrl: "https://api.test/v1", fetchImpl, retryBaseMs: 1, maxAttempts: 3 });
  return { p, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const req = { idempotencyKey: "7c9e6679-7425-40de-944b-e07fc1f90ae7", network: "linkedin" as const, accountExternalIds: ["A1"], text: "hi", media: [], options: {} };
const okPost = { success: true, post: { id: "P1", socialAccounts: [{ id: "A1", status: "pending" }] } };

describe("Outstand transport", () => {
  it("sends Bearer auth, Idempotency-Key and a correlation id", async () => {
    const { p, calls } = provider(() => json(200, okPost));
    await p.publish(req);
    const h = new Headers(calls[0]?.init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(h.get("idempotency-key")).toBe(req.idempotencyKey);
    expect(h.get("x-request-id")).toMatch(/.{8,}/);
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("retries a keyed create after 5xx and reuses the same Idempotency-Key", async () => {
    const { p, calls } = provider(({ n }) => (n === 1 ? json(502, { error: "bad gateway" }) : json(200, okPost)));
    const post = await p.publish(req);
    expect(post.externalId).toBe("P1");
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => new Headers(c.init.headers).get("idempotency-key")))).toEqual(new Set([req.idempotencyKey]));
  });

  it("never retries an unkeyed mutating request", async () => {
    const { p, calls } = provider(() => json(503, { error: "down" }));
    await expect(p.finalizeConnection("s", ["1"])).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });

  it("flags network failures of creates as ambiguous and retryable", async () => {
    const { p } = provider(() => {
      throw new TypeError("fetch failed");
    });
    const err = await p.publish(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).ambiguous).toBe(true);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it("maps 429 with Retry-After, 401 as auth, 400 as validation", async () => {
    const rl = await provider(() => json(429, { error: "slow down" }, { "retry-after": "120" })).p.getPost("P1").then(() => undefined as never, (e: unknown) => e as ProviderError);
    expect(rl).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 120 });
    const auth = await provider(() => json(401, { error: "Unauthorized" })).p.getPost("P1").then(() => undefined as never, (e: unknown) => e as ProviderError);
    expect(auth).toMatchObject({ kind: "auth", retryable: false });
    const val = await provider(() => json(400, { success: false, error: "scheduledAt cannot be more than 30 days" })).p.publish(req).then(() => undefined as never, (e: unknown) => e as ProviderError);
    expect(val).toMatchObject({ kind: "validation", retryable: false, ambiguous: false });
  });

  it("treats { success:false } on 2xx as a provider rejection", async () => {
    const err = await provider(() => json(200, { success: false, error: "nope" })).p.getPost("P1").then(() => undefined as never, (e: unknown) => e as ProviderError);
    expect(err.kind).toBe("validation");
  });

  it("never echoes the API key in error messages", async () => {
    const err = await provider(() => json(500, { error: `bad key ${KEY}` })).p.getPost("P1").then(() => undefined as never, (e: unknown) => e as ProviderError);
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err.details)).not.toContain(KEY);
  });

  it("delete is idempotent on 404", async () => {
    await expect(provider(() => json(404, { error: "Not found" })).p.deletePost("gone")).resolves.toBeUndefined();
  });

  it("refuses to hand a post beyond the scheduling horizon to Outstand", async () => {
    const { p, calls } = provider(() => json(200, okPost));
    await expect(p.schedule({ ...req, scheduledAt: new Date(Date.now() + 40 * 86_400_000) })).rejects.toMatchObject({ kind: "validation" });
    expect(calls).toHaveLength(0);
  });

  it("uploads from a URL without following redirects (SSRF)", async () => {
    const { p } = provider(({ url }) => (url.startsWith("https://src") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }) : json(200, {})));
    await expect(p.uploadFromUrl({ sourceUrl: "https://src.test/a.jpg", filename: "a.jpg", contentType: "image/jpeg", maxBytes: 1000 })).rejects.toMatchObject({ kind: "validation" });
  });

  it("enforces the size cap while streaming source media", async () => {
    const { p } = provider(({ url }) => (url.startsWith("https://src") ? new Response(new Uint8Array(5000)) : json(200, {})));
    await expect(p.uploadFromUrl({ sourceUrl: "https://src.test/a.jpg", filename: "a.jpg", contentType: "image/jpeg", maxBytes: 1000 })).rejects.toThrow(/exceeds/);
  });
});

describe("post update (PATCH /posts/{id})", () => {
  const upd = { network: "linkedin" as const, text: "v2", media: [], options: {}, scheduledAt: new Date(Date.now() + 2 * 86_400_000) };

  it("is unsupported unless explicitly enabled", async () => {
    const { p, calls } = provider(() => json(200, okPost));
    expect(p.supportsPostUpdate).toBe(false);
    await expect(p.updatePost("P1", upd)).rejects.toMatchObject({ kind: "unsupported" });
    expect(calls).toHaveLength(0);
  });

  it("sends containers/scheduledAt without accounts when enabled", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const p = new OutstandProvider({
      apiKey: KEY,
      webhookSecret: "whsec_0123456789abcdef",
      baseUrl: "https://api.test/v1",
      enablePostUpdate: true,
      fetchImpl: async (_u, init) => {
        calls.push({ init: init ?? {} });
        return json(200, okPost);
      },
    });
    await p.updatePost("P1", upd);
    expect(calls[0]?.init.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).not.toHaveProperty("accounts");
    expect(body.containers).toEqual([{ content: "v2" }]);
    expect(body.scheduledAt).toBe(upd.scheduledAt.toISOString());
  });
});
