import { isGatewayError, isUpstreamError } from "@zeptly-gateway/gateway-contract";
import { type JobRow, webhookEvents } from "@zeptly-gateway/database";
import { lt } from "drizzle-orm";
import type { JobHandler } from "./capabilities.js";
import { type ConnectionsContext, expireProvisioningSessions, reconcileConnections } from "./connections.js";
import type { GatewayContext } from "./context.js";
import { purgeExpiredIdempotencyKeys } from "./idempotency.js";
import { completeJob, failJob, purgeCompletedJobs } from "./jobs.js";
import { processWebhookEvent, type WebhookContext } from "./webhooks.js";

export const WEBHOOK_PAYLOAD_RETENTION_MS = 30 * 86_400_000;

/** Gateway-level housekeeping; capability modules contribute their own via CapabilityModule.housekeeping. */
export async function gatewayHousekeeping(ctx: GatewayContext): Promise<void> {
  const now = ctx.now();
  await expireProvisioningSessions(ctx.db, now);
  await purgeExpiredIdempotencyKeys(ctx);
  await purgeCompletedJobs(ctx.db, new Date(now.getTime() - 14 * 86_400_000));
  await ctx.db.update(webhookEvents).set({ payload: null }).where(lt(webhookEvents.receivedAt, new Date(now.getTime() - WEBHOOK_PAYLOAD_RETENTION_MS)));
}

export const str = (p: Record<string, unknown>, k: string): string => {
  const v = p[k];
  if (typeof v !== "string") throw new Error(`job payload missing ${k}`);
  return v;
};

/** Jobs owned by gateway infrastructure (independent of any capability). */
export function gatewayJobHandlers<C extends WebhookContext & ConnectionsContext>(housekeepingHooks: Array<(ctx: C) => Promise<void>>): Record<string, JobHandler<C>> {
  return {
    process_webhook: (ctx, p) => processWebhookEvent(ctx, str(p, "webhookEventId")),
    reconcile_connections: (ctx) => reconcileConnections(ctx, { service: "worker", requestId: "reconcile_connections" }),
    housekeeping: async (ctx) => {
      await gatewayHousekeeping(ctx);
      for (const hook of housekeepingHooks) await hook(ctx);
    },
  };
}

export const GATEWAY_PERIODIC_JOBS = [
  { type: "reconcile_connections", everyMs: 60 * 60_000 },
  { type: "housekeeping", everyMs: 60 * 60_000 },
];

/** Execute one claimed job with bounded retries; failures are recorded, never thrown. */
export async function runJob<C extends GatewayContext>(ctx: C, handlers: Record<string, JobHandler<C>>, job: JobRow, workerId: string): Promise<"succeeded" | "retry" | "dead"> {
  const handler = handlers[job.type];
  const log = ctx.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
  const started = performance.now();
  if (!handler) {
    await failJob(ctx.db, job, workerId, new Error(`unknown job type ${job.type}`), { retryable: false, now: ctx.now() });
    return "dead";
  }
  try {
    await handler(ctx, job.payload);
    await completeJob(ctx.db, job, workerId);
    log.info({ outcome: "success", latencyMs: Math.round(performance.now() - started) }, "job completed");
    return "succeeded";
  } catch (err) {
    const retryable = isUpstreamError(err) ? err.retryable : isGatewayError(err) ? err.retryable : true;
    const retryAfterMs = isUpstreamError(err) && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : undefined;
    const outcome = await failJob(ctx.db, job, workerId, err, { retryable, now: ctx.now(), ...(retryAfterMs ? { retryAfterMs } : {}) });
    log[outcome === "dead" ? "error" : "warn"]({ outcome, latencyMs: Math.round(performance.now() - started), err }, "job failed");
    return outcome;
  }
}
