import { metrics, type SocialAnalyticsContext, SocialMetricSchema } from "@zeptly-gateway/social-analytics";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, errorResponses } from "../app.js";
import { IdParams, security, workspaceHeaders, zapp } from "./common.js";

const MetricList = z.object({ data: z.array(SocialMetricSchema) }).meta({ id: "SocialMetricList" });

/** Social Analytics Contract v1 (canonical under /v1/social/analytics; /v1/metrics is a deprecated alias). */
export function registerMetricRoutes(app: FastifyInstance, ctx: SocialAnalyticsContext): void {
  for (const [list, refresh] of [
    ["/v1/social/analytics/metrics", "/v1/social/analytics/posts/:id/refresh"],
    ["/v1/metrics", "/v1/posts/:id/metrics/refresh"],
  ] as const) registerAt(app, ctx, list, refresh);
}

function registerAt(app: FastifyInstance, ctx: SocialAnalyticsContext, listPath: string, refreshPath: string): void {
  const r = zapp(app);
  r.get(
    listPath,
    {
      schema: {
        tags: ["social-analytics"],
        summary: "Stored metrics for a post or connection",
        description:
          "Only metrics the provider actually reports are returned. `semantics` (`<network>.<metric>`) identifies meaning: metrics with different semantics must not be treated as equivalent across networks.",
        security,
        headers: workspaceHeaders,
        querystring: z.object({
          postId: z.string().optional(),
          connectionId: z.string().optional(),
          history: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
          limit: z.coerce.number().int().min(1).max(1000).default(500),
        }),
        response: { 200: MetricList, ...errorResponses },
      },
    },
    async (req) => ({
      data: await metrics.queryMetrics(ctx, actorOf(req), {
        ...(req.query.postId ? { postId: req.query.postId } : {}),
        ...(req.query.connectionId ? { connectionId: req.query.connectionId } : {}),
        history: req.query.history,
        limit: req.query.limit,
      }),
    }),
  );

  r.post(
    refreshPath,
    {
      schema: { tags: ["social-analytics"], summary: "Fetch fresh metrics for a published post", security, headers: workspaceHeaders, params: IdParams, response: { 200: MetricList, ...errorResponses } },
    },
    async (req) => ({ data: await metrics.refreshPostMetrics(ctx, actorOf(req), req.params.id) }),
  );
}
