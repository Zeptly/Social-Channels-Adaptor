import { hostname } from "node:os";
import { claimJobs, dispatch, enqueuePeriodic, type JobType, runJob, type ServiceContext } from "@zeptly-social/core";
import { workerHeartbeats } from "@zeptly-social/database";

/** Periodic work, enqueued as deduplicated jobs so any number of replicas is safe. */
export const PERIODIC: Array<{ type: JobType; everyMs: number }> = [
  { type: "reconcile_publications", everyMs: 5 * 60_000 },
  { type: "reconcile_connections", everyMs: 60 * 60_000 },
  { type: "ingest_metrics", everyMs: 60 * 60_000 },
  { type: "sync_conversations", everyMs: 10 * 60_000 },
  { type: "housekeeping", everyMs: 60 * 60_000 },
];

export const HANDOFF_EVERY_MS = 60_000;

export interface WorkerOptions {
  concurrency: number;
  pollIntervalMs: number;
  workerId?: string;
  version?: string;
}

/**
 * Worker loop:
 *  - every tick: claim + run due jobs (webhook processing, reconciliation, media, metrics, ...);
 *  - every minute: rolling schedule hand-off (claim publications entering the provider horizon);
 *  - periodic jobs enqueued with dedupe; heartbeat row for observability.
 * Stops cleanly on SIGTERM: finishes in-flight work, claims nothing new.
 */
export class Worker {
  readonly workerId: string;
  private stopping = false;
  private lastHandoff = 0;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly opts: WorkerOptions,
  ) {
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}`;
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  /** One full iteration; exposed for tests. */
  async tick(): Promise<{ jobs: number; handedOff: number }> {
    const now = this.ctx.now();
    await this.ctx.db
      .insert(workerHeartbeats)
      .values({ workerId: this.workerId, startedAt: now, lastBeatAt: now, version: this.opts.version ?? null })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastBeatAt: now } });
    for (const p of PERIODIC) await enqueuePeriodic(this.ctx.db, p.type, p.everyMs, now);

    let handedOff = 0;
    if (now.getTime() - this.lastHandoff >= HANDOFF_EVERY_MS || this.lastHandoff === 0) {
      this.lastHandoff = now.getTime();
      const outcomes = await dispatch.runHandoff(this.ctx, this.workerId, { limit: 50 });
      handedOff = outcomes.length;
    }

    const claimed = await claimJobs(this.ctx.db, this.workerId, this.opts.concurrency, now);
    await Promise.all(claimed.map((j) => runJob(this.ctx, j, this.workerId)));
    return { jobs: claimed.length, handedOff };
  }

  private async run(): Promise<void> {
    this.ctx.logger.info({ workerId: this.workerId }, "worker started");
    while (!this.stopping) {
      let busy = false;
      try {
        const r = await this.tick();
        busy = r.jobs >= this.opts.concurrency;
      } catch (err) {
        this.ctx.logger.error({ err }, "worker tick failed");
      }
      if (!busy && !this.stopping) await new Promise((res) => setTimeout(res, this.opts.pollIntervalMs));
    }
    this.ctx.logger.info({ workerId: this.workerId }, "worker stopped");
  }
}
