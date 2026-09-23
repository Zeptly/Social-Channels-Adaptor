import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SocialError } from "@zeptly-social/domain";

/**
 * SSRF guard for Zeptly-supplied media URLs: HTTPS only, no credentials in the
 * URL, and the host must not be (or resolve to) a loopback, private, link-local,
 * CGNAT or otherwise non-public address.
 */
export async function assertPublicHttpsUrl(raw: string, opts: { skipDns?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SocialError("MEDIA_INVALID", "Media URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new SocialError("MEDIA_INVALID", "Media URL must use https");
  if (url.username || url.password) throw new SocialError("MEDIA_INVALID", "Media URL must not embed credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new SocialError("MEDIA_INVALID", "Media URL host is not public");
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new SocialError("MEDIA_INVALID", "Media URL host is not public");
    return url;
  }
  if (opts.skipDns) return url;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SocialError("MEDIA_INVALID", "Media URL host does not resolve");
  }
  if (addrs.length === 0 || addrs.some((a) => !isPublicAddress(a.address))) {
    throw new SocialError("MEDIA_INVALID", "Media URL host is not public");
  }
  return url;
}

export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const p = addr.split(".").map(Number) as [number, number, number, number];
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0 && p[2] === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (v === 6) {
    const s = addr.toLowerCase();
    if (s === "::1" || s === "::") return false;
    if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return false;
    if (s.startsWith("fc") || s.startsWith("fd")) return false;
    if (s.startsWith("ff")) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    return true;
  }
  return false;
}
