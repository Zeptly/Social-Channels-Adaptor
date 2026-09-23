import { type ServiceContext, webhooks } from "@zeptly-social/core";
import { SocialError } from "@zeptly-social/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponses } from "../app.js";
import { zapp } from "./common.js";

const Receipt = z.object({ accepted: z.boolean(), duplicate: z.boolean() }).meta({ id: "WebhookReceipt" });

export function registerWebhookRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  zapp(app).post(
    "/v1/webhooks/outstand",
    {
      config: { auth: "public" },
      bodyLimit: 1024 * 1024,
      schema: {
        tags: ["webhooks"],
        summary: "Outstand webhook receiver (HMAC-SHA256 signed)",
        description:
          "Verifies X-Outstand-Signature over the raw bytes, stores the receipt (deduplicated), enqueues processing and acknowledges. Invalid signatures → 401, nothing stored.",
        response: { 200: Receipt, ...errorResponses },
      },
    },
    async (req) => {
      if (!req.rawBody) throw new SocialError("VALIDATION_ERROR", "Webhook body must be application/json");
      const sig = req.headers["x-outstand-signature"];
      const receipt = await webhooks.receiveWebhook(ctx, "outstand", req.rawBody, typeof sig === "string" ? sig : undefined);
      return { accepted: receipt.accepted, duplicate: receipt.duplicate };
    },
  );
}
