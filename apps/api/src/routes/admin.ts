import { GatewayError } from "@zeptly-gateway/gateway-contract";
import { enqueueJob, listJobs, retryDeadJob } from "@zeptly-gateway/gateway-core";
import type { OutstandGatewayRuntime } from "@zeptly-gateway/outstand-gateway";
import { webhookEvents } from "@zeptly-gateway/database";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponses } from "../app.js";
import { IdParams, security, serviceHeaders, zapp } from "./common.js";

const Job = z
  .object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    attempts: z.number(),
    maxAttempts: z.number(),
    runAt: z.string(),
    lastError: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "Job" });

const WebhookEvent = z
  .object({ id: z.string(), provider: z.string(), eventType: z.string(), status: z.string(), attempts: z.number(), lastError: z.string().optional(), receivedAt: z.string() })
  .meta({ id: "WebhookEvent" });

/**
 * Operational endpoints (service-authenticated, no workspace). They expose
 * queue/webhook diagnostics only — no tenant content.
 */
export function registerAdminRoutes(app: FastifyInstance, rt: OutstandGatewayRuntime): void {
  const r = zapp(app);
  const ctx = rt.ctx;
  r.get(
    "/v1/admin/jobs",
    {
      config: { auth: "service" },
      schema: {
        tags: ["admin"],
        summary: "Inspect jobs (e.g. status=dead for dead letters)",
        security,
        headers: serviceHeaders,
        querystring: z.object({ status: z.enum(["pending", "running", "succeeded", "dead"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.object({ data: z.array(Job) }), ...errorResponses },
      },
    },
    async (req) => {
      const rows = await listJobs(ctx.db, { limit: req.query.limit, ...(req.query.status ? { status: req.query.status } : {}) });
      return {
        data: rows.map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
          runAt: j.runAt.toISOString(),
          ...(j.lastError ? { lastError: j.lastError } : {}),
          createdAt: j.createdAt.toISOString(),
          updatedAt: j.updatedAt.toISOString(),
        })),
      };
    },
  );

  r.post(
    "/v1/admin/jobs/:id/retry",
    { config: { auth: "service" }, schema: { tags: ["admin"], summary: "Requeue a dead job", security, headers: serviceHeaders, params: IdParams, response: { 200: z.object({ requeued: z.boolean() }), ...errorResponses } } },
    async (req) => {
      const ok = await retryDeadJob(ctx.db, req.params.id).catch(() => false);
      if (!ok) throw new GatewayError("NOT_FOUND", "No dead job with this id");
      return { requeued: true };
    },
  );

  r.get(
    "/v1/admin/webhook-events",
    {
      config: { auth: "service" },
      schema: {
        tags: ["admin"],
        summary: "Inspect received webhooks",
        security,
        headers: serviceHeaders,
        querystring: z.object({ status: z.enum(["received", "processing", "processed", "ignored", "failed"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.object({ data: z.array(WebhookEvent) }), ...errorResponses },
      },
    },
    async (req) => {
      const q = ctx.db.select().from(webhookEvents);
      const rows = await (req.query.status ? q.where(eq(webhookEvents.status, req.query.status)) : q).orderBy(desc(webhookEvents.receivedAt)).limit(req.query.limit);
      return {
        data: rows.map((w) => ({
          id: w.id,
          provider: w.provider,
          eventType: w.eventType,
          status: w.status,
          attempts: w.attempts,
          ...(w.lastError ? { lastError: w.lastError } : {}),
          receivedAt: w.receivedAt.toISOString(),
        })),
      };
    },
  );

  r.post(
    "/v1/admin/reconcile",
    {
      config: { auth: "service" },
      schema: {
        tags: ["admin"],
        summary: "Trigger reconciliation (all workspaces) after an incident",
        security,
        headers: serviceHeaders,
        response: { 202: z.object({ enqueued: z.array(z.string()) }), ...errorResponses },
      },
    },
    async (_req, reply) => {
      const enqueued: string[] = [];
      for (const type of ["reconcile_publications", "reconcile_connections"].filter((t) => rt.jobs[t])) {
        const id = await enqueueJob(ctx.db, type, {}, { dedupeKey: `admin:${type}`, runAt: ctx.now() });
        if (id) enqueued.push(type);
      }
      return reply.status(202).send({ enqueued });
    },
  );

}
