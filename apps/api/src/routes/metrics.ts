import { metrics, type ServiceContext } from "@zeptly-social/core";
import { SocialMetricSchema } from "@zeptly-social/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, errorResponses } from "../app.js";
import { security, workspaceHeaders, zapp } from "./common.js";

const MetricList = z.object({ data: z.array(SocialMetricSchema) }).meta({ id: "SocialMetricList" });

export function registerMetricRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  zapp(app).get(
    "/v1/metrics",
    {
      schema: {
        tags: ["metrics"],
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
}
