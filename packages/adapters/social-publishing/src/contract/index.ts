/**
 * Social Publishing Contract v1 (capability ids "social.publishing" and
 * "social.scheduling"). Canonical, provider-neutral domain: connections as
 * social networks, posts, targets, publications, media and schedules.
 * Depends only on zod and Gateway Contract v1.
 */
import "./errors.js";

export const SOCIAL_PUBLISHING_CONTRACT = { id: "social.publishing", version: "1" } as const;
export const SOCIAL_SCHEDULING_CONTRACT = { id: "social.scheduling", version: "1" } as const;

export * from "./networks.js";
export * from "./capabilities.js";
export * from "./models.js";
export * from "./status.js";
