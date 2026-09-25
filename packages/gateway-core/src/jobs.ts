import { type Executor, jobs, type JobRow } from "@zeptly-gateway/database";
import { redactString } from "@zeptly-gateway/observability";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

/**
 * PostgreSQL-backed durable job queue (gateway infrastructure).
 *  - enqueue with optional dedupe key (unique among pending/running jobs);
 *  - claim with FOR UPDATE SKIP LOCKED (safe across worker replicas);
 *  - bounded retries with exponential backoff, then `dead` (inspectable, retryable by admin);
 *  - stale `running` jobs (crashed worker) are recovered.
 */
/** Job types are strings owned by gateway infrastructure or by capability modules (see CapabilityModule.jobs). */
export type JobType = string;

export const STALE_JOB_MS = 10 * 60_000;
const JOB_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface EnqueueOptions {
  /** Pass the service clock (ctx.now()) so scheduling is consistent with claims. */
  runAt: Date;
  dedupeKey?: string;
  maxAttempts?: number;
  workspaceId?: string | null;
}

export async function enqueueJob(db: Executor, type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions): Promise<string | undefined> {
  const rows = await db
    .insert(jobs)
    .values({
      type,
      payload,
      runAt: opts.runAt,
      maxAttempts: opts.maxAttempts ?? 5,
      dedupeKey: opts.dedupeKey ?? null,
      workspaceId: opts.workspaceId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id;
}

/** Enqueue a periodic job unless one with the same key ran/was queued within `intervalMs`. */
export async function enqueuePeriodic(db: Executor, type: JobType, intervalMs: number, now: Date): Promise<boolean> {
  const key = `periodic:${type}`;
  const since = new Date(now.getTime() - intervalMs);
  const rows = await db.execute<{ id: string }>(sql`
    insert into jobs (type, payload, dedupe_key, max_attempts, run_at)
    select ${type}, '{}'::jsonb, ${key}, 3, ${now.toISOString()}::timestamptz
    where not exists (select 1 from jobs where dedupe_key = ${key} and run_at > ${since.toISOString()}::timestamptz)
    on conflict do nothing
    returning id`);
  return rows.rows.length > 0;
}

export async function claimJobs(db: Executor, workerId: string, limit: number, now: Date): Promise<JobRow[]> {
  const staleBefore = new Date(now.getTime() - STALE_JOB_MS);
  const res = await db.execute<{ id: string }>(sql`
    with eligible as (
      select id from jobs
      where (status = 'pending' and run_at <= ${now.toISOString()}::timestamptz)
         or (status = 'running' and locked_at < ${staleBefore.toISOString()}::timestamptz)
      order by run_at asc
      limit ${limit}
      for update skip locked
    )
    update jobs j set status = 'running', locked_by = ${workerId}, locked_at = ${now.toISOString()}::timestamptz,
      attempts = j.attempts + 1, updated_at = now()
    from eligible e where j.id = e.id
    returning j.id`);
  const ids = res.rows.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(jobs).where(inArray(jobs.id, ids));
}

export async function completeJob(db: Executor, job: JobRow, workerId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "succeeded", completedAt: new Date(), lockedBy: null, lockedAt: null, lastError: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId)));
}

export async function failJob(db: Executor, job: JobRow, workerId: string, err: unknown, opts: { retryable: boolean; retryAfterMs?: number; now?: Date }): Promise<"retry" | "dead"> {
  const message = redactString(err instanceof Error ? err.message : String(err)).slice(0, 2000);
  const exhausted = job.attempts >= job.maxAttempts;
  if (!opts.retryable || exhausted) {
    await db
      .update(jobs)
      .set({ status: "dead", lastError: message, lockedBy: null, lockedAt: null, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId)));
    return "dead";
  }
  const base = JOB_BACKOFF_MS[Math.min(job.attempts, JOB_BACKOFF_MS.length) - 1] ?? 60_000;
  const delay = Math.max(base, opts.retryAfterMs ?? 0);
  await db
    .update(jobs)
    .set({ status: "pending", runAt: new Date((opts.now ?? new Date()).getTime() + delay), lastError: message, lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId)));
  return "retry";
}

export async function listJobs(db: Executor, filter: { status?: string; limit: number }): Promise<JobRow[]> {
  const q = db.select().from(jobs);
  const rows = filter.status ? await q.where(eq(jobs.status, filter.status)).orderBy(desc(jobs.updatedAt)).limit(filter.limit) : await q.orderBy(desc(jobs.updatedAt)).limit(filter.limit);
  return rows;
}

/** Admin: requeue a dead job with a fresh attempt budget. */
export async function retryDeadJob(db: Executor, id: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "pending", attempts: 0, runAt: new Date(), lastError: null, completedAt: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "dead")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function purgeCompletedJobs(db: Executor, olderThan: Date): Promise<void> {
  await db.delete(jobs).where(and(eq(jobs.status, "succeeded"), lt(jobs.updatedAt, olderThan)));
}
