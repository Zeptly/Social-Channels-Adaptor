import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SocialError } from "@zeptly-social/domain";

/**
 * Service-to-service authentication (Zeptly → Zeptly Social).
 *
 * V1 scheme "ZS1-HMAC-SHA256" with a shared service secret:
 *
 *   X-Zeptly-Caller:        calling service identity (e.g. "zeptly-app")
 *   X-Zeptly-Workspace-Id:  Zeptly workspace id (required on workspace routes)
 *   X-Zeptly-Agent:         optional agent/user reference (audit)
 *   X-Zeptly-Timestamp:     unix seconds; must be within ±300 s
 *   X-Zeptly-Signature:     "v1=" + hex(HMAC-SHA256(secret, canonical))
 *   X-Request-Id:           correlation id (generated when absent)
 *
 *   canonical = "ZS1\n" + timestamp + "\n" + METHOD + "\n" + path?query + "\n"
 *             + workspaceId + "\n" + caller + "\n" + agent + "\n" + hex(SHA256(raw body))
 *
 * Everything that determines authority (workspace, caller, agent, body) is
 * signed, so a request cannot be replayed against another workspace. Rotation:
 * the previous secret (ZEPTLY_SERVICE_SECRET_PREVIOUS) is accepted until removed.
 *
 * The `ServiceAuthenticator` interface is the migration seam: an asymmetric
 * implementation (e.g. Ed25519 / JWT service identity) can replace this one
 * without any route or endpoint change.
 */

export interface AuthenticatedCaller {
  service: string;
  workspaceExternalId?: string;
  agent?: string;
  scheme: string;
}

export interface AuthRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer | undefined;
}

export interface ServiceAuthenticator {
  authenticate(req: AuthRequest): AuthenticatedCaller;
}

export const MAX_SKEW_SECONDS = 300;
const CALLER_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function header(h: AuthRequest["headers"], name: string): string | undefined {
  const v = h[name];
  if (Array.isArray(v)) return v.length === 1 ? v[0] : undefined;
  return v;
}

export function canonicalString(p: { timestamp: string; method: string; url: string; workspaceId: string; caller: string; agent: string; body: Buffer | undefined }): string {
  const bodyHash = createHash("sha256")
    .update(p.body ?? Buffer.alloc(0))
    .digest("hex");
  return ["ZS1", p.timestamp, p.method.toUpperCase(), p.url, p.workspaceId, p.caller, p.agent, bodyHash].join("\n");
}

export function signRequest(secret: string, p: Parameters<typeof canonicalString>[0]): string {
  return `v1=${createHmac("sha256", secret).update(canonicalString(p)).digest("hex")}`;
}

export class HmacServiceAuthenticator implements ServiceAuthenticator {
  private readonly secrets: string[];
  constructor(
    current: string,
    previous?: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.secrets = [current, ...(previous ? [previous] : [])];
  }

  authenticate(req: AuthRequest): AuthenticatedCaller {
    const fail = (reason: string) => new SocialError("AUTHENTICATION_FAILED", "Request authentication failed", { details: { reason } });
    const caller = header(req.headers, "x-zeptly-caller");
    const ts = header(req.headers, "x-zeptly-timestamp");
    const sig = header(req.headers, "x-zeptly-signature");
    const workspaceId = header(req.headers, "x-zeptly-workspace-id") ?? "";
    const agent = header(req.headers, "x-zeptly-agent") ?? "";
    if (!caller || !ts || !sig) throw fail("missing authentication headers");
    if (!CALLER_PATTERN.test(caller)) throw fail("invalid caller");
    if (!/^\d{9,11}$/.test(ts)) throw fail("invalid timestamp");
    if (Math.abs(this.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) throw fail("timestamp outside allowed skew");
    const m = /^v1=([0-9a-f]{64})$/.exec(sig);
    if (!m?.[1]) throw fail("malformed signature");
    const got = Buffer.from(m[1], "hex");
    const canonical = canonicalString({ timestamp: ts, method: req.method, url: req.url, workspaceId, caller, agent, body: req.rawBody });
    const ok = this.secrets.some((s) => {
      const expected = createHmac("sha256", s).update(canonical).digest();
      return expected.length === got.length && timingSafeEqual(expected, got);
    });
    if (!ok) throw fail("signature mismatch");
    return {
      service: caller,
      scheme: "ZS1-HMAC-SHA256",
      ...(workspaceId ? { workspaceExternalId: workspaceId } : {}),
      ...(agent ? { agent: agent.slice(0, 200) } : {}),
    };
  }
}
