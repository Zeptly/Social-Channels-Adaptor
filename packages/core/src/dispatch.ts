import { type ErrorCode, SocialError, type SocialNetwork, aggregatePostStatus, type PostStatus, type TargetStatus } from "@zeptly-social/domain";
import {
  type Executor,
  providerAccounts,
  socialPosts,
  type SocialPostTargetRow,
  socialPostTargets,
  type SocialPublicationRow,
  socialPublications,
  socialSchedules,
} from "@zeptly-social/database";
import { ProviderError, type ProviderPostState } from "@zeptly-social/provider-contract";
import { redactString } from "@zeptly-social/observability";
import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit, recordProviderEvent } from "./audit.js";
import type { ServiceContext, SystemActor } from "./context.js";
import { resolveProviderMedia } from "./media.js";
import { safeMessage, toSocialError } from "./provider-errors.js";
import { getConnectionsForWorkspace } from "./tenancy.js";

/**
 * Publication = durable dispatch queue entry (pattern proven in the Outstand-UI
 * reference). Guarantees:
 *  - the provider Idempotency-Key is generated and persisted by the claim,
 *    BEFORE any network request, and reused on every retry of that publication;
 *  - claims use FOR UPDATE SKIP LOCKED and results are fenced on the claim
 *    owner, so a stale worker can never overwrite a newer outcome;
 *  - an ambiguous failure (timeout / 5xx / 409 after send) is only retried while
 *    the key is younger than 23h (Outstand remembers keys for 24h), otherwise the
 *    publication fails as PUBLICATION_STATE_UNKNOWN for review — never a silent duplicate;
 *  - every requested target is compared with the provider's accepted targets:
 *    a missing target becomes an explicit TARGET_DROPPED_BY_PROVIDER failure.
 */

export const IDEMPOTENCY_SAFE_RETRY_MS = 23 * 3600_000;
export const STALE_CLAIM_MS = 10 * 60_000;
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3600_000];
/** Posts due within this window are published immediately rather than provider-scheduled. */
export const IMMEDIATE_WINDOW_MS = 60_000;

export type PublicationStatus = "pending" | "dispatching" | "retry_pending" | "accepted" | "published" | "partially_published" | "failed" | "cancelled";

export function backoffFor(attempt: number, retryAfterSeconds?: number): number {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1] ?? 60_000;
  return Math.max(base, (retryAfterSeconds ?? 0) * 1000);
}

/** Latest publish instant that may be handed to the provider now. */
export function handoffHorizonEnd(now: Date, providerHorizonMs: number | undefined, marginMs: number): Date {
  if (providerHorizonMs === undefined) return new Date(8.64e15);
  return new Date(now.getTime() + providerHorizonMs - marginMs);
}

const worker: SystemActor = { service: "worker", requestId: "dispatch" };

export async function claimPublications(
  ctx: ServiceContext,
  opts: { workerId: string; limit: number; provider: string; ids?: string[] },
): Promise<SocialPublicationRow[]> {
  const now = ctx.now();
  const provider = ctx.providers.get(opts.provider);
  const horizon = handoffHorizonEnd(now, provider.schedulingHorizonMs, ctx.settings.handoffMarginMs);
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const idFilter = opts.ids?.length ? sql`and p.id in (${sql.join(opts.ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``;
  const res = await ctx.db.execute<{ id: string }>(sql`
    with eligible as (
      select p.id from social_publications p
      where p.provider = ${opts.provider}
        and p.publish_at <= ${horizon.toISOString()}::timestamptz
        and (
          p.status = 'pending'
          or (p.status = 'retry_pending' and coalesce(p.next_attempt_at, p.publish_at) <= ${now.toISOString()}::timestamptz)
          or (p.status = 'dispatching' and p.locked_at < ${staleBefore.toISOString()}::timestamptz)
        )
        ${idFilter}
      order by p.publish_at asc
      limit ${opts.limit}
      for update skip locked
    )
    update social_publications u set
      status = 'dispatching',
      locked_by = ${opts.workerId},
      locked_at = ${now.toISOString()}::timestamptz,
      attempts = u.attempts + 1,
      idempotency_key = coalesce(u.idempotency_key, gen_random_uuid()),
      idempotency_key_created_at = coalesce(u.idempotency_key_created_at, ${now.toISOString()}::timestamptz),
      updated_at = now()
    from eligible e
    where u.id = e.id
    returning u.id`);
  const ids = res.rows.map((r) => r.id);
  if (ids.length === 0) return [];
  return ctx.db.select().from(socialPublications).where(inArray(socialPublications.id, ids));
}

interface TargetWithAccount {
  target: SocialPostTargetRow;
  accountExternalId: string | undefined;
}

async function loadTargets(db: Executor, pub: SocialPublicationRow): Promise<TargetWithAccount[]> {
  const rows = await db
    .select({ target: socialPostTargets, externalId: providerAccounts.externalId })
    .from(socialPostTargets)
    .leftJoin(
      providerAccounts,
      and(eq(providerAccounts.connectionId, socialPostTargets.connectionId), eq(providerAccounts.workspaceId, pub.workspaceId), eq(providerAccounts.provider, pub.provider)),
    )
    .where(and(eq(socialPostTargets.publicationId, pub.id), eq(socialPostTargets.workspaceId, pub.workspaceId)));
  return rows.map((r) => ({ target: r.target, accountExternalId: r.externalId ?? undefined }));
}

export interface DispatchOutcome {
  publicationId: string;
  status: PublicationStatus;
}

/** Hand one claimed publication to its provider. Safe to call again for the same row. */
export async function dispatchClaimed(ctx: ServiceContext, pub: SocialPublicationRow, workerId: string): Promise<DispatchOutcome> {
  const log = ctx.logger.child({ publicationId: pub.id, postId: pub.postId, attempt: pub.attempts, provider: pub.provider });
  if (!pub.idempotencyKey) throw new Error("invariant: idempotency key must be persisted before dispatch");
  try {
    const all = await loadTargets(ctx.db, pub);
    const open = all.filter((t) => t.target.status === "pending" || t.target.status === "scheduled" || t.target.status === "publishing");
    const conns = await getConnectionsForWorkspace(
      ctx.db,
      pub.workspaceId,
      open.map((t) => t.target.connectionId),
    );
    const blocked: Array<{ targetId: string; code: ErrorCode; message: string }> = [];
    const eligible: TargetWithAccount[] = [];
    for (const t of open) {
      const c = conns.get(t.target.connectionId);
      if (!c || !t.accountExternalId) blocked.push({ targetId: t.target.id, code: "CONNECTION_NOT_FOUND", message: "Connection mapping not found" });
      else if (c.connection.status === "reauthorization_required") blocked.push({ targetId: t.target.id, code: "REAUTHORIZATION_REQUIRED", message: "The connection must be reauthorized" });
      else if (c.connection.status !== "connected" && c.connection.status !== "degraded") blocked.push({ targetId: t.target.id, code: "CONNECTION_NOT_ACTIVE", message: `Connection is ${c.connection.status}` });
      else eligible.push(t);
    }
    if (blocked.length) await failTargets(ctx.db, pub, blocked);
    if (eligible.length === 0) {
      return await finalizeFailure(ctx, pub, workerId, new SocialError("CONNECTION_NOT_ACTIVE", "No active connection remains for this publication"), { terminal: true });
    }
    const now = ctx.now();
    const scheduledAt = pub.publishAt.getTime() > now.getTime() + IMMEDIATE_WINDOW_MS ? pub.publishAt : undefined;
    const media = await resolveProviderMedia(ctx, pub.workspaceId, pub.snapshot.mediaIds, pub.publishAt);
    const provider = ctx.providers.get(pub.provider);
    const request = {
      idempotencyKey: pub.idempotencyKey,
      network: pub.network as SocialNetwork,
      accountExternalIds: eligible.map((t) => t.accountExternalId as string),
      text: pub.snapshot.text,
      media,
      options: pub.snapshot.options,
    };
    log.info({ targets: eligible.length, scheduled: Boolean(scheduledAt) }, "dispatching publication");
    const remote = scheduledAt ? await provider.schedule({ ...request, scheduledAt }) : await provider.publish(request);
    return await applyRemoteState(ctx, pub, remote, { source: "dispatch", workerId, requestedTargetIds: eligible.map((t) => t.target.id) });
  } catch (err) {
    return finalizeFailure(ctx, pub, workerId, err);
  }
}

async function failTargets(db: Executor, pub: SocialPublicationRow, failures: Array<{ targetId: string; code: ErrorCode; message: string }>): Promise<void> {
  const now = new Date();
  for (const f of failures) {
    await db
      .update(socialPostTargets)
      .set({ status: "failed", errorCode: f.code, errorMessage: f.message, updatedAt: now })
      .where(and(eq(socialPostTargets.id, f.targetId), eq(socialPostTargets.workspaceId, pub.workspaceId)));
  }
}

type Settled = { status: TargetStatus; platformPostId: string | null; platformPostUrl: string | null; publishedAt: Date | null; errorCode: string | null; errorMessage: string | null };

/**
 * Pure: decide a target's next state from the provider's view.
 * Outside the initial dispatch a known terminal outcome (published/failed) is
 * never reverted by a lagging provider view (pending/missing).
 */
export function settleTarget(
  local: Pick<SocialPostTargetRow, "status" | "platformPostId" | "platformPostUrl" | "publishedAt" | "errorCode" | "errorMessage">,
  remote: ProviderPostState["targets"][number] | undefined,
  ctx: { source: "dispatch" | "webhook" | "reconcile"; futureSchedule: boolean; remotePublishedAt: Date | undefined; now: Date },
): Settled {
  const keep: Settled = {
    status: local.status as TargetStatus,
    platformPostId: local.platformPostId,
    platformPostUrl: local.platformPostUrl,
    publishedAt: local.publishedAt,
    errorCode: local.errorCode,
    errorMessage: local.errorMessage,
  };
  const knownTerminal = local.status === "published" || local.status === "failed" || local.status === "cancelled";
  if (!remote) {
    if (ctx.source !== "dispatch" && knownTerminal) return keep;
    return { ...keep, status: "failed", errorCode: "TARGET_DROPPED_BY_PROVIDER", errorMessage: "The provider did not accept this destination" };
  }
  switch (remote.status) {
    case "published":
      return {
        status: "published",
        platformPostId: remote.platformPostId ?? local.platformPostId,
        platformPostUrl: remote.platformPostUrl ?? local.platformPostUrl,
        publishedAt: remote.publishedAt ?? local.publishedAt ?? ctx.remotePublishedAt ?? ctx.now,
        errorCode: null,
        errorMessage: null,
      };
    case "failed":
      if (local.status === "published" && ctx.source !== "reconcile") return keep;
      return { ...keep, status: "failed", errorCode: "PUBLICATION_FAILED", errorMessage: redactString(remote.error ?? "Publishing failed on the network").slice(0, 1000) };
    case "deleted":
      return { ...keep, status: "cancelled", errorCode: null, errorMessage: "Deleted at the provider or on the network" };
    default:
      if (ctx.source !== "dispatch" && (local.status === "published" || local.status === "failed")) return keep;
      return { ...keep, status: ctx.futureSchedule ? "scheduled" : "publishing" };
  }
}

export function aggregatePublicationStatus(statuses: TargetStatus[]): PublicationStatus {
  if (statuses.length === 0) return "failed";
  if (statuses.some((s) => s === "pending" || s === "scheduled" || s === "publishing")) return "accepted";
  const published = statuses.filter((s) => s === "published").length;
  if (published === statuses.length) return "published";
  if (published > 0) return "partially_published";
  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  return "failed";
}

export async function applyRemoteState(
  ctx: ServiceContext,
  pub: SocialPublicationRow,
  remote: ProviderPostState,
  opts: { source: "dispatch" | "webhook" | "reconcile"; workerId?: string; requestedTargetIds?: string[] },
): Promise<DispatchOutcome> {
  const now = ctx.now();
  const targets = await loadTargets(ctx.db, pub);
  const remoteByAccount = new Map(remote.targets.map((t) => [t.accountExternalId, t]));
  const requested = opts.requestedTargetIds ? new Set(opts.requestedTargetIds) : undefined;
  const futureSchedule = pub.publishAt.getTime() > now.getTime() + IMMEDIATE_WINDOW_MS;
  const dropped: string[] = [];
  const outcome = await ctx.db.transaction(async (tx) => {
    const fence =
      opts.source === "dispatch" && opts.workerId ? and(eq(socialPublications.lockedBy, opts.workerId), eq(socialPublications.status, "dispatching")) : undefined;
    // Take the row lock first so concurrent webhook/reconcile applications serialize.
    const locked = await tx.select({ id: socialPublications.id, status: socialPublications.status }).from(socialPublications).where(and(eq(socialPublications.id, pub.id), fence)).for("update");
    if (locked.length === 0) return null;
    if (opts.source !== "dispatch" && locked[0]?.status === "cancelled") return { publicationId: pub.id, status: "cancelled" as PublicationStatus };
    const finalStatuses: TargetStatus[] = [];
    for (const { target, accountExternalId } of targets) {
      const inScope = requested ? requested.has(target.id) : target.status !== "cancelled" && target.errorCode !== "REAUTHORIZATION_REQUIRED" && target.errorCode !== "CONNECTION_NOT_ACTIVE" && target.errorCode !== "CONNECTION_NOT_FOUND";
      if (!inScope) {
        finalStatuses.push(target.status as TargetStatus);
        continue;
      }
      const r = accountExternalId ? remoteByAccount.get(accountExternalId) : undefined;
      const next = settleTarget(target, r, { source: opts.source, futureSchedule, remotePublishedAt: remote.publishedAt, now });
      if (!r && next.errorCode === "TARGET_DROPPED_BY_PROVIDER") dropped.push(target.id);
      finalStatuses.push(next.status);
      if (
        next.status !== target.status ||
        next.platformPostId !== target.platformPostId ||
        next.platformPostUrl !== target.platformPostUrl ||
        next.errorCode !== target.errorCode ||
        next.errorMessage !== target.errorMessage
      ) {
        await tx.update(socialPostTargets).set({ ...next, updatedAt: now }).where(and(eq(socialPostTargets.id, target.id), eq(socialPostTargets.workspaceId, pub.workspaceId)));
      }
    }
    const status = aggregatePublicationStatus(finalStatuses);
    await tx
      .update(socialPublications)
      .set({
        status,
        providerPostId: remote.externalId,
        handedOffAt: pub.handedOffAt ?? now,
        lastReconciledAt: now,
        ...(opts.source === "dispatch" ? { lockedBy: null, lockedAt: null, nextAttemptAt: null, lastErrorCode: dropped.length ? "TARGET_DROPPED_BY_PROVIDER" : null, lastError: dropped.length ? `${dropped.length} destination(s) were not accepted by the provider` : null } : {}),
        updatedAt: now,
      })
      .where(eq(socialPublications.id, pub.id));
    await recomputePostStatus(tx, pub.postId, pub.workspaceId, worker);
    if (status !== pub.status) {
      await recordAudit(tx, opts.source === "webhook" ? { service: "webhook:outstand", requestId: pub.id } : worker, {
        workspaceId: pub.workspaceId,
        action: `publication.${opts.source}.${status}`,
        resourceType: "publication",
        resourceId: pub.id,
        metadata: { postId: pub.postId, dropped: dropped.length },
      });
      await recordProviderEvent(tx, {
        workspaceId: pub.workspaceId,
        provider: pub.provider,
        source: opts.source === "webhook" ? "webhook" : opts.source === "dispatch" ? "dispatch" : "reconciliation",
        type: "publication.status_changed",
        resourceType: "publication",
        resourceId: pub.id,
        summary: { from: pub.status, to: status },
        occurredAt: now,
      });
    }
    return { publicationId: pub.id, status };
  });
  if (!outcome) {
    ctx.logger.warn({ publicationId: pub.id }, "dispatch result discarded: claim no longer held");
    return { publicationId: pub.id, status: "dispatching" };
  }
  if (dropped.length) ctx.logger.warn({ publicationId: pub.id, dropped: dropped.length }, "provider dropped requested destinations");
  return outcome;
}

async function finalizeFailure(ctx: ServiceContext, pub: SocialPublicationRow, workerId: string, err: unknown, opts: { terminal?: boolean } = {}): Promise<DispatchOutcome> {
  const now = ctx.now();
  const se = toSocialError(err, "PUBLICATION_FAILED");
  const pe = err instanceof ProviderError ? err : undefined;
  const retryable = !opts.terminal && (pe ? pe.retryable : se.retryable);
  const ambiguous = pe?.ambiguous ?? false;
  const keyAge = pub.idempotencyKeyCreatedAt ? now.getTime() - pub.idempotencyKeyCreatedAt.getTime() : 0;
  const exhausted = pub.attempts >= pub.maxAttempts;
  const keyTooOld = ambiguous && keyAge >= IDEMPOTENCY_SAFE_RETRY_MS;
  const message = safeMessage(err);
  ctx.logger.warn({ publicationId: pub.id, code: se.code, retryable, ambiguous, exhausted, err }, "publication dispatch failed");

  if (retryable && !exhausted && !keyTooOld) {
    const next = new Date(now.getTime() + backoffFor(pub.attempts, pe?.retryAfterSeconds));
    await ctx.db
      .update(socialPublications)
      .set({ status: "retry_pending", nextAttemptAt: next, lastErrorCode: se.code, lastError: message, lockedBy: null, lockedAt: null, updatedAt: now })
      .where(and(eq(socialPublications.id, pub.id), eq(socialPublications.lockedBy, workerId), eq(socialPublications.status, "dispatching")));
    return { publicationId: pub.id, status: "retry_pending" };
  }

  const code: ErrorCode = ambiguous ? "PUBLICATION_STATE_UNKNOWN" : se.code === "PROVIDER_REJECTED" ? "PUBLICATION_FAILED" : se.code;
  const targetMessage = ambiguous
    ? "The provider may or may not have accepted this publication; manual review required"
    : se.code === "PROVIDER_REJECTED"
      ? `The provider rejected the publication: ${String((se.details?.provider as { message?: string } | undefined)?.message ?? message).slice(0, 500)}`
      : se.message;
  const done = await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(socialPublications)
      .set({ status: "failed", lastErrorCode: code, lastError: message, nextAttemptAt: null, lockedBy: null, lockedAt: null, updatedAt: now })
      .where(and(eq(socialPublications.id, pub.id), eq(socialPublications.lockedBy, workerId), eq(socialPublications.status, "dispatching")))
      .returning({ id: socialPublications.id });
    if (updated.length === 0) return false;
    await tx
      .update(socialPostTargets)
      .set({ status: "failed", errorCode: code, errorMessage: targetMessage, updatedAt: now })
      .where(
        and(
          eq(socialPostTargets.publicationId, pub.id),
          eq(socialPostTargets.workspaceId, pub.workspaceId),
          inArray(socialPostTargets.status, ["pending", "scheduled", "publishing"]),
        ),
      );
    await recomputePostStatus(tx, pub.postId, pub.workspaceId, worker);
    await recordAudit(tx, worker, { workspaceId: pub.workspaceId, action: "publication.failed", resourceType: "publication", resourceId: pub.id, metadata: { postId: pub.postId, code, attempts: pub.attempts } });
    return true;
  });
  return { publicationId: pub.id, status: done ? "failed" : "dispatching" };
}

/** Recompute the canonical post status from its targets; audit terminal transitions. */
export async function recomputePostStatus(tx: Executor, postId: string, workspaceId: string, actor: SystemActor): Promise<PostStatus | undefined> {
  const [post] = await tx.select().from(socialPosts).where(and(eq(socialPosts.id, postId), eq(socialPosts.workspaceId, workspaceId))).for("update");
  if (!post) return undefined;
  const targets = await tx.select({ status: socialPostTargets.status }).from(socialPostTargets).where(eq(socialPostTargets.postId, postId));
  const next = aggregatePostStatus(
    targets.map((t) => t.status as TargetStatus),
    post.status as PostStatus,
  );
  if (next !== post.status) {
    await tx.update(socialPosts).set({ status: next, updatedAt: new Date() }).where(eq(socialPosts.id, postId));
    if (next === "published" || next === "partially_published" || next === "failed") {
      await recordAudit(tx, actor, {
        workspaceId,
        action: next === "failed" ? "post.publication_failed" : next === "published" ? "post.publication_succeeded" : "post.publication_partial",
        resourceType: "post",
        resourceId: postId,
        metadata: { from: post.status, to: next },
      });
    }
    if (next === "published" || next === "partially_published" || next === "failed" || next === "cancelled") {
      await tx.update(socialSchedules).set({ status: next === "cancelled" ? "cancelled" : "completed", updatedAt: new Date() }).where(eq(socialSchedules.postId, postId));
    }
  }
  return next;
}

/** Claim + dispatch eligible publications (worker hand-off tick, or API publish-now). */
export async function runHandoff(ctx: ServiceContext, workerId: string, opts: { limit?: number; ids?: string[] } = {}): Promise<DispatchOutcome[]> {
  const outcomes: DispatchOutcome[] = [];
  for (const provider of ctx.providers.names()) {
    const claimed = await claimPublications(ctx, { workerId, limit: opts.limit ?? 25, provider, ...(opts.ids ? { ids: opts.ids } : {}) });
    for (const pub of claimed) outcomes.push(await dispatchClaimed(ctx, pub, workerId));
  }
  return outcomes;
}
