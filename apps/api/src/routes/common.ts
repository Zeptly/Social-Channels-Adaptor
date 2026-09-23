import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

export type ZApp = ReturnType<FastifyInstance["withTypeProvider"]> & FastifyInstance;

export function zapp(app: FastifyInstance) {
  return app.withTypeProvider<ZodTypeProvider>();
}

export const security = [{ zeptlyServiceSignature: [] }];

/** Documented (and validated) auth headers for workspace-scoped routes. */
export const workspaceHeaders = z
  .object({
    "x-zeptly-workspace-id": z.string().min(1).max(128).describe("Zeptly workspace identifier (signed)"),
    "x-zeptly-caller": z.string().describe("Calling service identity (signed)"),
    "x-zeptly-timestamp": z.string().describe("Unix seconds (signed)"),
    "x-zeptly-signature": z.string().describe("v1=<hex HMAC-SHA256>"),
    "x-zeptly-agent": z.string().optional().describe("Optional agent/user reference recorded in audit events (signed)"),
    "x-request-id": z.string().optional().describe("Correlation id; echoed in responses"),
  })
  .loose();

export const idempotentHeaders = workspaceHeaders.extend({
  "idempotency-key": z.string().min(8).max(128).describe("Required. Replays return the original response; reuse with a different body → IDEMPOTENCY_CONFLICT."),
});

export const serviceHeaders = workspaceHeaders.omit({ "x-zeptly-workspace-id": true }).loose();

export const IdParams = z.object({ id: z.string().min(1).max(64) });
