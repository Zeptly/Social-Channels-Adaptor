import { socialPostTargets, type SocialPublicationRow, socialPublications } from "@zeptly-gateway/database";
import { UpstreamError } from "@zeptly-gateway/gateway-contract";
import { enqueueJob, recordAudit } from "@zeptly-gateway/gateway-core";
import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { SocialPublishingContext } from "./context.js";
import { applyRemoteState, recomputePostStatus } from "./dispatch.js";

/**
 * Publication reconciliation: the provider's authoritative per-target state
 * (GET post) is applied to the local ledger. Safe to rerun any number of times.
 */
export async function reconcilePublication(ctx: SocialPublishingContext, publicationId: string, source: "webhook" | "reconcile" = "reconcile"): Promise<string> {
  const [pub] = await ctx.db.select().from(socialPublications).where(eq(socialPublications.id, publicationId)).limit(1);
  if (!pub?.providerPostId) return "skipped";
  if (pub.status === "cancelled" || pub.status === "failed") return pub.status;
  const provider = ctx.publishing;
  try {
    const remote = await provider.getPost(pub.providerPostId);
    return (await applyRemoteState(ctx, pub, remote, { source })).status;
  } catch (err) {
    if (err instanceof UpstreamError && err.kind === "not_found") return markVanished(ctx, pub);
    throw err;
  }
}

/** The provider no longer knows the post: non-terminal targets fail explicitly. */
async function markVanished(ctx: SocialPublishingContext, pub: SocialPublicationRow): Promise<string> {
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(socialPostTargets)
      .set({ status: "failed", errorCode: "PUBLICATION_STATE_UNKNOWN", errorMessage: "The post no longer exists at the provider", updatedAt: now })
      .where(and(eq(socialPostTargets.publicationId, pub.id), inArray(socialPostTargets.status, ["pending", "scheduled", "publishing"])));
    const targets = await tx.select({ status: socialPostTargets.status }).from(socialPostTargets).where(eq(socialPostTargets.publicationId, pub.id));
    const published = targets.filter((t) => t.status === "published").length;
    const status = published === 0 ? "failed" : published === targets.length ? "published" : "partially_published";
    await tx.update(socialPublications).set({ status, lastReconciledAt: now, lastErrorCode: "PUBLICATION_STATE_UNKNOWN", lastError: "Post not found at provider", updatedAt: now }).where(eq(socialPublications.id, pub.id));
    await recomputePostStatus(tx, pub.postId, pub.workspaceId, { service: "worker", requestId: "reconcile" });
    await recordAudit(tx, { service: "worker", requestId: "reconcile" }, { workspaceId: pub.workspaceId, action: "publication.reconcile.vanished", resourceType: "publication", resourceId: pub.id });
  });
  return "vanished";
}

/**
 * Periodic scan (also run after service recovery): publications the provider
 * accepted whose publish time has passed but that are not yet terminal, or
 * that have not been reconciled recently. Webhooks are not the only source of truth.
 */
export async function enqueueDueReconciliations(ctx: SocialPublishingContext, limit = 100): Promise<number> {
  const now = ctx.now();
  const overdue = new Date(now.getTime() - 5 * 60_000);
  const stale = new Date(now.getTime() - 15 * 60_000);
  const rows = await ctx.db
    .select({ id: socialPublications.id, workspaceId: socialPublications.workspaceId })
    .from(socialPublications)
    .where(
      and(
        eq(socialPublications.status, "accepted"),
        isNotNull(socialPublications.providerPostId),
        lt(socialPublications.publishAt, overdue),
        or(isNull(socialPublications.lastReconciledAt), lt(socialPublications.lastReconciledAt, stale)),
      ),
    )
    .limit(limit);
  for (const r of rows) {
    await enqueueJob(ctx.db, "reconcile_publication", { publicationId: r.id }, { dedupeKey: `reconcile_publication:${r.id}`, workspaceId: r.workspaceId, runAt: now });
  }
  return rows.length;
}
