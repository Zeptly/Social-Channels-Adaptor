import { PaginationQuerySchema, page } from "@zeptly-gateway/gateway-contract";
import { assertIdempotencyKey, withIdempotency } from "@zeptly-gateway/gateway-core";
import {
  CreatePostRequestSchema,
  PostStatusSchema,
  posts,
  reconcile,
  SchedulePostRequestSchema,
  type SocialPublishingContext,
  SocialPostSchema,
  SocialPublicationSchema,
  UpdatePostRequestSchema,
} from "@zeptly-gateway/social-publishing";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, errorResponses, idempotencyHeader } from "../app.js";
import { IdParams, idempotentHeaders, security, workspaceHeaders, zapp } from "./common.js";

const PostPage = page(SocialPostSchema, "SocialPostPage");
const PublicationList = z.object({ data: z.array(SocialPublicationSchema) }).meta({ id: "SocialPublicationList" });

/** Social Publishing Contract v1 posts (canonical under /v1/social/publishing; /v1/posts is a deprecated alias). */
export function registerPostRoutes(app: FastifyInstance, ctx: SocialPublishingContext): void {
  for (const base of ["/v1/social/publishing", "/v1"]) registerAt(app, ctx, base);
}

function registerAt(app: FastifyInstance, ctx: SocialPublishingContext, base: string): void {
  const r = zapp(app);

  r.post(
    `${base}/posts`,
    {
      schema: {
        tags: ["social-publishing"],
        summary: "Create a post (draft) with its targets",
        description: "Validates every target against the workspace's connections and the network constraints. Idempotent on Idempotency-Key.",
        security,
        headers: idempotentHeaders,
        body: CreatePostRequestSchema,
        response: { 200: SocialPostSchema, 201: SocialPostSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const key = assertIdempotencyKey(idempotencyHeader(req));
      const res = await posts.createPost(ctx, actorOf(req), req.body, key);
      if (res.replayed) reply.header("idempotency-replay", "true");
      return reply.status(res.replayed ? 200 : 201).send(res.post);
    },
  );

  r.get(
    `${base}/posts`,
    {
      schema: {
        tags: ["social-publishing"],
        summary: "List posts",
        security,
        headers: workspaceHeaders,
        querystring: PaginationQuerySchema.extend({ status: PostStatusSchema.optional() }),
        response: { 200: PostPage, ...errorResponses },
      },
    },
    async (req) => posts.listPosts(ctx, actorOf(req), req.query),
  );

  r.get(
    `${base}/posts/:id`,
    { schema: { tags: ["social-publishing"], summary: "Get a post with per-target status", security, headers: workspaceHeaders, params: IdParams, response: { 200: SocialPostSchema, ...errorResponses } } },
    async (req) => posts.getPost(ctx, actorOf(req), req.params.id),
  );

  r.patch(
    `${base}/posts/:id`,
    {
      schema: {
        tags: ["social-publishing"],
        summary: "Edit a draft or scheduled post (same post id)",
        description:
          "Replaces base content and/or the target list (variants, options). Scheduled posts are re-planned: provider copies already handed off are updated in place when supported (OUTSTAND_POST_UPDATE_ENABLED), otherwise replaced. Rejected once any target is publishing or published.",
        security,
        headers: idempotentHeaders,
        params: IdParams,
        body: UpdatePostRequestSchema,
        response: { 200: SocialPostSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const key = assertIdempotencyKey(idempotencyHeader(req));
      const res = await withIdempotency(ctx, actor, "post.update", key, { id: req.params.id, body: req.body }, async () => ({
        status: 200,
        body: await posts.updatePost(ctx, actor, req.params.id, req.body),
      }));
      if (res.replayed) reply.header("idempotency-replay", "true");
      return reply.status(200).send(res.body);
    },
  );

  const command = (
    path: string,
    op: string,
    summary: string,
    description: string,
    run: (actor: ReturnType<typeof actorOf>, id: string, body: unknown) => Promise<unknown>,
    body?: z.ZodType,
  ) =>
    r.post(
      path,
      {
        schema: {
          tags: ["social-publishing"],
          summary,
          description,
          security,
          headers: idempotentHeaders,
          params: IdParams,
          ...(body ? { body } : {}),
          response: { 202: SocialPostSchema, ...errorResponses },
        },
      },
      async (req, reply) => {
        const actor = actorOf(req);
        const key = assertIdempotencyKey(idempotencyHeader(req));
        const res = await withIdempotency(ctx, actor, op, key, { id: req.params.id, body: req.body ?? null }, async () => ({
          status: 202,
          body: await run(actor, req.params.id, req.body),
        }));
        if (res.replayed) reply.header("idempotency-replay", "true");
        return reply.status(202).send(res.body as z.infer<typeof SocialPostSchema>);
      },
    );

  command(
    `${base}/posts/:id/publish`,
    "post.publish",
    "Publish now",
    "Queues immediate publication and attempts hand-off synchronously. Poll GET /v1/social/publishing/posts/{id} for per-target outcomes. Re-publishing an already queued/published post is a no-op.",
    (actor, id) => posts.publishPost(ctx, actor, id),
  );
  command(
    `${base}/posts/:id/schedule`,
    "post.schedule",
    "Schedule or reschedule",
    "Stores the canonical schedule (any horizon). The post is handed to the provider automatically once it enters the provider's scheduling window (Outstand: OUTSTAND_SCHEDULING_HORIZON_DAYS).",
    (actor, id, body) => posts.schedulePost(ctx, actor, id, body as z.infer<typeof SchedulePostRequestSchema>),
    SchedulePostRequestSchema,
  );
  command(
    `${base}/posts/:id/cancel`,
    "post.cancel",
    "Cancel unpublished targets",
    "Cancels queued/scheduled publications, deleting provider-side scheduled copies where the network supports delete.",
    (actor, id) => posts.cancelPost(ctx, actor, id),
  );

  r.get(
    `${base}/posts/:id/publications`,
    {
      schema: { tags: ["social-publishing"], summary: "Provider submissions for this post", security, headers: workspaceHeaders, params: IdParams, response: { 200: PublicationList, ...errorResponses } },
    },
    async (req) => ({ data: await posts.listPublications(ctx, actorOf(req), req.params.id) }),
  );

  r.post(
    `${base}/posts/:id/reconcile`,
    {
      schema: {
        tags: ["social-publishing"],
        summary: "Reconcile this post with the provider now",
        security,
        headers: workspaceHeaders,
        params: IdParams,
        response: { 200: SocialPostSchema, ...errorResponses },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const pubs = await posts.listPublications(ctx, actor, req.params.id);
      for (const p of pubs) await reconcile.reconcilePublication(ctx, p.id);
      return posts.getPost(ctx, actor, req.params.id);
    },
  );
}
