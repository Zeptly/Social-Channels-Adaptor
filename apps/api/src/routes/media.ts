import { CompleteMediaUploadRequestSchema, media, RegisterMediaRequestSchema, SocialMediaSchema, type SocialPublishingContext } from "@zeptly-gateway/social-publishing";
import type { FastifyInstance } from "fastify";
import { actorOf, errorResponses } from "../app.js";
import { IdParams, security, workspaceHeaders, zapp } from "./common.js";

/** Social Publishing Contract v1 media (canonical under /v1/social/publishing; /v1/media is a deprecated alias). */
export function registerMediaRoutes(app: FastifyInstance, ctx: SocialPublishingContext): void {
  for (const base of ["/v1/social/publishing", "/v1"]) registerAt(app, ctx, base);
}

function registerAt(app: FastifyInstance, ctx: SocialPublishingContext, base: string): void {
  const r = zapp(app);
  r.post(
    `${base}/media`,
    {
      schema: {
        tags: ["social-publishing"],
        summary: "Register media for publishing",
        description:
          "source.type=url|asset: the durable HTTPS URL is fetched by the worker and handed to the provider (status processing → ready|failed). source.type=upload: the response carries a short-lived `uploadUrl`; PUT the bytes there, then call …/media/{id}/complete. Media bytes are never stored in this service's database.",
        security,
        headers: workspaceHeaders,
        body: RegisterMediaRequestSchema,
        response: { 201: SocialMediaSchema, ...errorResponses },
      },
    },
    async (req, reply) => reply.status(201).send(await media.registerMedia(ctx, actorOf(req), req.body)),
  );
  r.get(
    `${base}/media/:id`,
    { schema: { tags: ["social-publishing"], summary: "Get media status", security, headers: workspaceHeaders, params: IdParams, response: { 200: SocialMediaSchema, ...errorResponses } } },
    async (req) => media.getMedia(ctx, actorOf(req), req.params.id),
  );
  r.post(
    `${base}/media/:id/complete`,
    {
      schema: {
        tags: ["social-publishing"],
        summary: "Confirm a direct upload",
        security,
        headers: workspaceHeaders,
        params: IdParams,
        body: CompleteMediaUploadRequestSchema,
        response: { 200: SocialMediaSchema, ...errorResponses },
      },
    },
    async (req) => media.completeMediaUpload(ctx, actorOf(req), req.params.id, req.body ?? {}),
  );
}
