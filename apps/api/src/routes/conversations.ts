import { PaginationQuerySchema, page } from "@zeptly-gateway/gateway-contract";
import { assertIdempotencyKey } from "@zeptly-gateway/gateway-core";
import { conversations, SendMessageRequestSchema, type SocialDirectMessagesContext, SocialConversationSchema, SocialMessageSchema } from "@zeptly-gateway/social-direct-messages";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, errorResponses, idempotencyHeader } from "../app.js";
import { IdParams, idempotentHeaders, security, workspaceHeaders, zapp } from "./common.js";

const ConversationPage = page(SocialConversationSchema, "SocialConversationPage");
const MessagePage = page(SocialMessageSchema, "SocialMessagePage");

/** Social Direct Messages Contract v1 (canonical under /v1/social/direct-messages; /v1/conversations is a deprecated alias). */
export function registerConversationRoutes(app: FastifyInstance, ctx: SocialDirectMessagesContext): void {
  for (const base of ["/v1/social/direct-messages", "/v1"]) registerAt(app, ctx, base);
}

function registerAt(app: FastifyInstance, ctx: SocialDirectMessagesContext, base: string): void {
  const r = zapp(app);
  const note =
    "Capability-gated. V1 supports Instagram direct messages only; other networks return CAPABILITY_NOT_SUPPORTED (check connection.capabilities.conversations).";

  r.get(
    `${base}/conversations`,
    {
      schema: {
        tags: ["social-direct-messages"],
        summary: "List conversations",
        description: note,
        security,
        headers: workspaceHeaders,
        querystring: PaginationQuerySchema.extend({ connectionId: z.string().optional() }),
        response: { 200: ConversationPage, ...errorResponses },
      },
    },
    async (req) =>
      conversations.listConversations(ctx, actorOf(req), {
        limit: req.query.limit,
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
        ...(req.query.connectionId ? { connectionId: req.query.connectionId } : {}),
      }),
  );

  r.get(
    `${base}/conversations/:id`,
    { schema: { tags: ["social-direct-messages"], summary: "Get a conversation", description: note, security, headers: workspaceHeaders, params: IdParams, response: { 200: SocialConversationSchema, ...errorResponses } } },
    async (req) => conversations.getConversation(ctx, actorOf(req), req.params.id),
  );

  r.get(
    `${base}/conversations/:id/messages`,
    {
      schema: {
        tags: ["social-direct-messages"],
        summary: "List messages (newest first)",
        description: `${note} Pass refresh=true to pull the latest page from the provider first.`,
        security,
        headers: workspaceHeaders,
        params: IdParams,
        querystring: PaginationQuerySchema.extend({
          refresh: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
        }),
        response: { 200: MessagePage, ...errorResponses },
      },
    },
    async (req) =>
      conversations.listMessages(ctx, actorOf(req), req.params.id, {
        limit: req.query.limit,
        refresh: req.query.refresh,
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
      }),
  );

  r.post(
    `${base}/conversations/:id/messages`,
    {
      schema: {
        tags: ["social-direct-messages"],
        summary: "Reply in a conversation",
        description: `${note} Instagram only allows replies to conversations the contact started, within Meta's messaging window.`,
        security,
        headers: idempotentHeaders,
        params: IdParams,
        body: SendMessageRequestSchema,
        response: { 200: SocialMessageSchema, 201: SocialMessageSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const key = assertIdempotencyKey(idempotencyHeader(req));
      const res = await conversations.sendMessage(ctx, actorOf(req), req.params.id, req.body.text, key);
      if (res.replayed) reply.header("idempotency-replay", "true");
      return reply.status(res.replayed ? 200 : 201).send(res.message);
    },
  );
}
