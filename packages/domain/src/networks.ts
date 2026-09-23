import { z } from "zod";

/**
 * V1 network boundary: the Outstand Managed-Key network set only.
 * X/Twitter, Reddit, Google Business Profile and Vimeo require BYOK and are
 * deliberately NOT representable in the public contract.
 */
export const SOCIAL_NETWORKS = [
  "linkedin",
  "instagram",
  "facebook",
  "threads",
  "tiktok",
  "pinterest",
  "youtube",
  "bluesky",
] as const;

export const SocialNetworkSchema = z.enum(SOCIAL_NETWORKS);
export type SocialNetwork = z.infer<typeof SocialNetworkSchema>;

export function isSocialNetwork(value: unknown): value is SocialNetwork {
  return typeof value === "string" && (SOCIAL_NETWORKS as readonly string[]).includes(value);
}

/** Provider identifiers. Only "outstand" is implemented in V1. */
export const PROVIDER_NAMES = ["outstand"] as const;
export const ProviderNameSchema = z.enum(PROVIDER_NAMES);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const ConnectionStrategySchema = z.enum(["oauth_redirect", "credentials", "provider_managed"]);
export type ConnectionStrategy = z.infer<typeof ConnectionStrategySchema>;
