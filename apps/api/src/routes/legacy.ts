/**
 * Pre-gateway paths kept as deprecated aliases for one release (docs/API.md
 * "Breaking changes"). Each alias runs the same handler as its canonical route;
 * OpenAPI marks it deprecated and responses carry `Deprecation: true` plus a
 * `Link` to the successor path.
 */
export const LEGACY_ALIASES: ReadonlyArray<readonly [legacy: string, canonical: string]> = [
  ["/v1/posts/:id/metrics/refresh", "/v1/social/analytics/posts/:id/refresh"],
  ["/v1/posts", "/v1/social/publishing/posts"],
  ["/v1/media", "/v1/social/publishing/media"],
  ["/v1/networks", "/v1/social/publishing/networks"],
  ["/v1/metrics", "/v1/social/analytics/metrics"],
  ["/v1/conversations", "/v1/social/direct-messages/conversations"],
];

export function canonicalFor(url: string): string | undefined {
  for (const [legacy, canonical] of LEGACY_ALIASES) {
    if (url === legacy || url.startsWith(`${legacy}/`)) return canonical + url.slice(legacy.length);
  }
  return undefined;
}
