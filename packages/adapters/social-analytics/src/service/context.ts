import type { SocialPublishingContext } from "@zeptly-gateway/social-publishing";
import type { SocialAnalyticsPort } from "../port.js";

/**
 * Social Analytics reads the Social Publishing ledger (publications and
 * targets) to know which provider posts to measure — a deliberate, documented
 * coupling: analytics here means "metrics of posts this gateway published".
 */
export interface SocialAnalyticsContext extends SocialPublishingContext {
  analytics: SocialAnalyticsPort;
}
