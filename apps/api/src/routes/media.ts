import { media, type ServiceContext } from "@zeptly-social/core";
import { CompleteMediaUploadRequestSchema, RegisterMediaRequestSchema, SocialMediaSchema } from "@zeptly-social/domain";
import type { FastifyInstance } from "fastify";
import { actorOf, errorResponses } from "../app.js";
import { IdParams, security, workspaceHeaders, zapp } from "./common.js";

export function registerMediaRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  const r = zapp(app);
  r.post(
    "/v1/media",
    {
      schema: {
        tags: ["media"],
        summary: "Register media for publishing",
        description:
          "source.type=url|asset: the durable HTTPS URL is fetched by the worker and handed to the provider (status processing → ready|failed). source.type=upload: the response carries a short-lived `uploadUrl`; PUT the bytes there, then call /v1/media/{id}/complete. Media bytes are never stored in this service's database.",
        security,
        headers: workspaceHeaders,
        body: RegisterMediaRequestSchema,
        response: { 201: SocialMediaSchema, ...errorResponses },
      },
    },
    async (req, reply) => reply.status(201).send(await media.registerMedia(ctx, actorOf(req), req.body)),
  );
  r.get(
    "/v1/media/:id",
    { schema: { tags: ["media"], summary: "Get media status", security, headers: workspaceHeaders, params: IdParams, response: { 200: SocialMediaSchema, ...errorResponses } } },
    async (req) => media.getMedia(ctx, actorOf(req), req.params.id),
  );
  r.post(
    "/v1/media/:id/complete",
    {
      schema: {
        tags: ["media"],
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
