import { claimJobs, dispatch, enqueueJob, enqueuePeriodic, runJob } from "@zeptly-social/core";
import { jobs } from "@zeptly-social/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, idem } from "../../api/test/helpers.js";
import { Worker } from "../src/runtime.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ inlineDispatch: false });
});
afterEach(async () => {
  await h.close();
});

describe("PostgreSQL job queue", () => {
  it("bounded retries end in a dead, inspectable, requeueable job", async () => {
    const id = await enqueueJob(h.ctx.db, "reconcile_publication", {}, { runAt: h.clock.now(), maxAttempts: 2 }); // missing payload → handler throws
    for (let i = 0; i < 3; i++) {
      const claimed = await claimJobs(h.ctx.db, "w1", 10, h.clock.now());
      for (const j of claimed) await runJob(h.ctx, j, "w1");
      h.clock.advance(10 * 60_000);
    }
    const [row] = await h.ctx.db.select().from(jobs).where(eq(jobs.id, id as string));
    expect(row).toMatchObject({ status: "dead", attempts: 2 });
    expect(row?.lastError).toContain("publicationId");
    const listed = await h.call(null, "GET", "/v1/admin/jobs?status=dead");
    expect(listed.json.data.map((j: { id: string }) => j.id)).toContain(id);
    expect((await h.call(null, "POST", `/v1/admin/jobs/${id}/retry`)).json).toEqual({ requeued: true });
  });

  it("recovers jobs abandoned by a crashed worker", async () => {
    const id = await enqueueJob(h.ctx.db, "housekeeping", {}, { runAt: h.clock.now() });
    const first = await claimJobs(h.ctx.db, "crashed", 10, h.clock.now());
    expect(first.map((j) => j.id)).toEqual([id]);
    expect(await claimJobs(h.ctx.db, "other", 10, h.clock.now())).toEqual([]);
    h.clock.advance(11 * 60_000);
    const again = await claimJobs(h.ctx.db, "other", 10, h.clock.now());
    expect(again.map((j) => j.id)).toEqual([id]);
  });

  it("deduplicates active jobs and periodic enqueues across replicas", async () => {
    expect(await enqueueJob(h.ctx.db, "process_webhook", { webhookEventId: "x" }, { runAt: h.clock.now(), dedupeKey: "k1" })).toBeDefined();
    expect(await enqueueJob(h.ctx.db, "process_webhook", { webhookEventId: "x" }, { runAt: h.clock.now(), dedupeKey: "k1" })).toBeUndefined();
    expect(await enqueuePeriodic(h.ctx.db, "housekeeping", 3600_000, h.clock.now())).toBe(true);
    expect(await enqueuePeriodic(h.ctx.db, "housekeeping", 3600_000, h.clock.now())).toBe(false);
  });

  it("concurrent hand-off workers never dispatch the same publication twice", async () => {
    const [c] = await h.connect("ws_jobs", "linkedin");
    const post = await h.call("ws_jobs", "POST", "/v1/posts", { content: { text: "race" }, targets: [{ connectionId: c.id }] }, { "idempotency-key": idem() });
    await h.call("ws_jobs", "POST", `/v1/posts/${post.json.id}/publish`, undefined, { "idempotency-key": idem() });
    const results = await Promise.all([dispatch.runHandoff(h.ctx, "w-a"), dispatch.runHandoff(h.ctx, "w-b"), dispatch.runHandoff(h.ctx, "w-c")]);
    expect(results.flat()).toHaveLength(1);
    expect(h.fake.posts.size).toBe(1);
  });

  it("the worker tick writes a heartbeat and runs periodic work", async () => {
    const w = new Worker(h.ctx, { concurrency: 4, pollIntervalMs: 10, workerId: "hb" });
    await w.tick();
    const hb = await h.db.pool.query("select worker_id from worker_heartbeats");
    expect(hb.rows).toEqual([{ worker_id: "hb" }]);
    const types = (await h.db.pool.query("select distinct type from jobs")).rows.map((r) => r.type).sort();
    expect(types).toEqual(["housekeeping", "ingest_metrics", "reconcile_connections", "reconcile_publications", "sync_conversations"]);
  });
});
