import { GatewayError, WebhookReceiptSchema } from "@zeptly-gateway/gateway-contract";
import { receiveWebhook, type WebhookContext } from "@zeptly-gateway/gateway-core";
import type { FastifyInstance } from "fastify";
import { errorResponses } from "../app.js";
import { zapp } from "./common.js";

export function registerWebhookRoutes(app: FastifyInstance, ctx: WebhookContext): void {
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
        response: { 200: WebhookReceiptSchema, ...errorResponses },
      },
    },
    async (req) => {
      if (!req.rawBody) throw new GatewayError("VALIDATION_ERROR", "Webhook body must be application/json");
      const sig = req.headers[ctx.webhookSource.signatureHeader];
      const receipt = await receiveWebhook(ctx, req.rawBody, typeof sig === "string" ? sig : undefined);
      return { accepted: receipt.accepted, duplicate: receipt.duplicate };
    },
  );
}
