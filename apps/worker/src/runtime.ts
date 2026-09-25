import { hostname } from "node:os";
import { claimJobs, enqueuePeriodic, type GatewayContext, type JobHandler, type PeriodicJob, runJob, type WorkerTick } from "@zeptly-gateway/gateway-core";
import { workerHeartbeats } from "@zeptly-gateway/database";

/** What the worker runs: supplied by the gateway composition (gateway jobs + capability modules). */
export interface WorkerPlan<C extends GatewayContext> {
  ctx: C;
  jobs: Record<string, JobHandler<C>>;
  /** Enqueued as deduplicated jobs so any number of replicas is safe. */
  periodic: PeriodicJob[];
  /** Fixed-cadence work outside the queue (e.g. the Social Publishing schedule hand-off). */
  ticks: WorkerTick<C>[];
}

export interface WorkerOptions {
  concurrency: number;
  pollIntervalMs: number;
  workerId?: string;
  version?: string;
}

/**
 * Worker loop:
 *  - every tick: claim + run due jobs (webhook processing, reconciliation, media, metrics, ...);
 *  - capability ticks on their cadence (e.g. rolling schedule hand-off every minute);
 *  - periodic jobs enqueued with dedupe; heartbeat row for observability.
 * Stops cleanly on SIGTERM: finishes in-flight work, claims nothing new.
 */
export class Worker<C extends GatewayContext> {
  readonly workerId: string;
  private stopping = false;
  private readonly lastRun = new Map<string, number>();
  private loop: Promise<void> | undefined;
  private readonly ctx: C;

  constructor(
    private readonly plan: WorkerPlan<C>,
    private readonly opts: WorkerOptions,
  ) {
    this.ctx = plan.ctx;
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}`;
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  /** One full iteration; exposed for tests. `handedOff` counts work done by capability ticks. */
  async tick(): Promise<{ jobs: number; handedOff: number }> {
    const now = this.ctx.now();
    await this.ctx.db
      .insert(workerHeartbeats)
      .values({ workerId: this.workerId, startedAt: now, lastBeatAt: now, version: this.opts.version ?? null })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastBeatAt: now } });
    for (const p of this.plan.periodic) await enqueuePeriodic(this.ctx.db, p.type, p.everyMs, now);

    let handedOff = 0;
    for (const t of this.plan.ticks) {
      const last = this.lastRun.get(t.name);
      if (last === undefined || now.getTime() - last >= t.everyMs) {
        this.lastRun.set(t.name, now.getTime());
        handedOff += await t.run(this.ctx, this.workerId);
      }
    }

    const claimed = await claimJobs(this.ctx.db, this.workerId, this.opts.concurrency, now);
    await Promise.all(claimed.map((j) => runJob(this.ctx, this.plan.jobs, j, this.workerId)));
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
