import type { CapabilityModule } from "@zeptly-gateway/gateway-core";
import { SOCIAL_ANALYTICS_CONTRACT } from "../contract.js";
import type { SocialAnalyticsContext } from "./context.js";
import { ingestDueMetrics } from "./metrics.js";

/** Social Analytics (basic): provider-reported metrics for posts published through this gateway. */
export function socialAnalyticsModule(channels: () => string[]): CapabilityModule<SocialAnalyticsContext> {
  return {
    descriptor: { ...SOCIAL_ANALYTICS_CONTRACT, title: "Social analytics (basic)", description: "Provider-reported metrics for posts published through this gateway." },
    channels,
    jobs: { ingest_metrics: (ctx) => ingestDueMetrics(ctx) },
    periodic: [{ type: "ingest_metrics", everyMs: 60 * 60_000 }],
  };
}
