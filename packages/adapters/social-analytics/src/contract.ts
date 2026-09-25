/**
 * Social Analytics Contract v1 (capability id "social.analytics.basic").
 * Snapshots of the metrics the provider actually reports for published
 * social posts. Metric names are not normalized across networks.
 */
import { z } from "zod";
import { SocialNetworkSchema } from "@zeptly-gateway/social-publishing/contract";

export const SOCIAL_ANALYTICS_CONTRACT = { id: "social.analytics.basic", version: "1" } as const;

export const SocialMetricSchema = z
  .object({
    workspaceId: z.string(),
    connectionId: z.uuid().optional(),
    postId: z.uuid().optional(),
    targetId: z.uuid().optional(),
    network: SocialNetworkSchema,
    metric: z.string().describe("Provider-reported metric name, namespaced by network semantics — not cross-network comparable"),
    value: z.number(),
    measuredAt: z.iso.datetime({ offset: true }),
    provider: z.string(),
    semantics: z
      .string()
      .describe("`<network>.<metric>` key. Metrics with different semantics keys must not be treated as equivalent."),
  })
  .meta({ id: "SocialMetric" });
export type SocialMetric = z.infer<typeof SocialMetricSchema>;
