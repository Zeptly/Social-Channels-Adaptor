import { describe, expect, it } from "vitest";
import { HmacServiceAuthenticator, signRequest } from "../src/auth.js";

const SECRET = "current-secret-0123456789-0123456789";
const OLD = "previous-secret-0123456789-012345678";
const now = 1_790_000_000_000;
const ts = String(now / 1000);

function request(overrides: Partial<{ secret: string; ws: string; body: string; url: string; method: string; ts: string; sigWs: string; agent: string }> = {}) {
  const body = Buffer.from(overrides.body ?? '{"a":1}');
  const params = { timestamp: overrides.ts ?? ts, method: "POST", url: "/v1/posts", workspaceId: overrides.sigWs ?? "ws_a", caller: "zeptly-app", agent: overrides.agent ?? "", body };
  return {
    method: overrides.method ?? "POST",
    url: overrides.url ?? "/v1/posts",
    rawBody: body,
    headers: {
      "x-zeptly-caller": "zeptly-app",
      "x-zeptly-timestamp": overrides.ts ?? ts,
      "x-zeptly-workspace-id": overrides.ws ?? "ws_a",
      "x-zeptly-signature": signRequest(overrides.secret ?? SECRET, params),
      ...(overrides.agent ? { "x-zeptly-agent": overrides.agent } : {}),
    },
  };
}

describe("ZS1 HMAC service authentication", () => {
  const auth = new HmacServiceAuthenticator(SECRET, OLD, () => now);

  it("authenticates caller, workspace and agent", () => {
    expect(auth.authenticate(request({ agent: "agent:planner" }))).toEqual({ service: "zeptly-app", workspaceExternalId: "ws_a", agent: "agent:planner", scheme: "ZS1-HMAC-SHA256" });
  });

  it("accepts the previous secret during rotation", () => {
    expect(auth.authenticate(request({ secret: OLD })).service).toBe("zeptly-app");
    expect(() => new HmacServiceAuthenticator(SECRET, undefined, () => now).authenticate(request({ secret: OLD }))).toThrow();
  });

  it("rejects a workspace swapped after signing (cross-tenant replay)", () => {
    expect(() => auth.authenticate(request({ ws: "ws_b", sigWs: "ws_a" }))).toThrow(expect.objectContaining({ code: "AUTHENTICATION_FAILED" }));
  });

  it("rejects tampered bodies, paths, methods and stale timestamps", () => {
    const r = request();
    expect(() => auth.authenticate({ ...r, rawBody: Buffer.from('{"a":2}') })).toThrow();
    expect(() => auth.authenticate({ ...r, url: "/v1/posts?x=1" })).toThrow();
    expect(() => auth.authenticate({ ...r, method: "DELETE" })).toThrow();
    expect(() => auth.authenticate(request({ ts: String(now / 1000 - 301) }))).toThrow(/authentication failed/);
    expect(() => auth.authenticate(request({ secret: "wrong-secret-0123456789-0123456789" }))).toThrow();
  });

  it("rejects missing or malformed headers", () => {
    const r = request();
    expect(() => auth.authenticate({ ...r, headers: {} })).toThrow();
    expect(() => auth.authenticate({ ...r, headers: { ...r.headers, "x-zeptly-signature": "v2=abc" } })).toThrow();
    expect(() => auth.authenticate({ ...r, headers: { ...r.headers, "x-zeptly-caller": "Bad Caller!" } })).toThrow();
  });
});
