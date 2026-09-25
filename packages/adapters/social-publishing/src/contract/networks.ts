import { z } from "zod";

/**
 * Social networks representable in Social Publishing Contract v1. A gateway
 * implementing the contract states which of them it actually serves.
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
