import { socialMedia, webhookEvents } from "@zeptly-social/database";
import type { JobRow } from "@zeptly-social/database";
import { isSocialError } from "@zeptly-social/domain";
import { ProviderError } from "@zeptly-social/provider-contract";
import { and, eq, lt } from "drizzle-orm";
import { expireProvisioningSessions, reconcileConnections } from "./connections.js";
import type { ServiceContext } from "./context.js";
import { syncConversations } from "./conversations.js";
import { purgeExpiredIdempotencyKeys } from "./idempotency.js";
import { completeJob, failJob, type JobType, purgeCompletedJobs } from "./jobs.js";
import { processMediaUpload } from "./media.js";
import { ingestDueMetrics } from "./metrics.js";
import { enqueueDueReconciliations, reconcilePublication } from "./reconcile.js";
import { processWebhookEvent } from "./webhooks.js";

export const WEBHOOK_PAYLOAD_RETENTION_MS = 30 * 86_400_000;

export async function housekeeping(ctx: ServiceContext): Promise<void> {
  const now = ctx.now();
  await expireProvisioningSessions(ctx.db, now);
  await purgeExpiredIdempotencyKeys(ctx);
  await purgeCompletedJobs(ctx.db, new Date(now.getTime() - 14 * 86_400_000));
  await ctx.db.update(webhookEvents).set({ payload: null }).where(lt(webhookEvents.receivedAt, new Date(now.getTime() - WEBHOOK_PAYLOAD_RETENTION_MS)));
  await ctx.db
    .update(socialMedia)
    .set({ status: "failed", error: "Upload was never completed", updatedAt: now })
    .where(and(eq(socialMedia.status, "pending_upload"), lt(socialMedia.createdAt, new Date(now.getTime() - 86_400_000))));
}

type Handler = (ctx: ServiceContext, payload: Record<string, unknown>) => Promise<unknown>;

const str = (p: Record<string, unknown>, k: string): string => {
  const v = p[k];
  if (typeof v !== "string") throw new Error(`job payload missing ${k}`);
  return v;
};

export const JOB_HANDLERS: Record<JobType, Handler> = {
  process_webhook: (ctx, p) => processWebhookEvent(ctx, str(p, "webhookEventId")),
  upload_media: (ctx, p) => processMediaUpload(ctx, str(p, "mediaId")),
  reconcile_publication: (ctx, p) => reconcilePublication(ctx, str(p, "publicationId")),
  reconcile_publications: (ctx) => enqueueDueReconciliations(ctx),
  reconcile_connections: (ctx) => reconcileConnections(ctx, { service: "worker", requestId: "reconcile_connections" }),
  ingest_metrics: (ctx) => ingestDueMetrics(ctx),
  sync_conversations: (ctx) => syncConversations(ctx),
  housekeeping: (ctx) => housekeeping(ctx),
};

/** Execute one claimed job with bounded retries; failures are recorded, never thrown. */
export async function runJob(ctx: ServiceContext, job: JobRow, workerId: string): Promise<"succeeded" | "retry" | "dead"> {
  const handler = JOB_HANDLERS[job.type as JobType];
  const log = ctx.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
  const started = performance.now();
  if (!handler) {
    await failJob(ctx.db, job, workerId, new Error(`unknown job type ${job.type}`), { retryable: false });
    return "dead";
  }
  try {
    await handler(ctx, job.payload);
    await completeJob(ctx.db, job, workerId);
    log.info({ outcome: "success", latencyMs: Math.round(performance.now() - started) }, "job completed");
    return "succeeded";
  } catch (err) {
    const retryable = err instanceof ProviderError ? err.retryable : isSocialError(err) ? err.retryable : true;
    const retryAfterMs = err instanceof ProviderError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : undefined;
    const outcome = await failJob(ctx.db, job, workerId, err, { retryable, now: ctx.now(), ...(retryAfterMs ? { retryAfterMs } : {}) });
    log[outcome === "dead" ? "error" : "warn"]({ outcome, latencyMs: Math.round(performance.now() - started), err }, "job failed");
    return outcome;
  }
}
