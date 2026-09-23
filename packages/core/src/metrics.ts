import { SocialError, type SocialMetric, type SocialNetwork } from "@zeptly-social/domain";
import {
  providerAccounts,
  socialMetrics,
  socialPostTargets,
  type SocialPublicationRow,
  socialPublications,
} from "@zeptly-social/database";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Actor, ServiceContext } from "./context.js";
import { getPost } from "./posts.js";
import { toSocialError } from "./provider-errors.js";
import { toMetric } from "./serializers.js";
import { assertUuid, getConnectionForWorkspace } from "./tenancy.js";

export const METRICS_REFRESH_MS = 6 * 3600_000;
export const METRICS_WINDOW_MS = 30 * 86_400_000;

/**
 * Snapshot the metrics the provider actually reports for one publication.
 * Metric names are kept as reported (platform-specific ones namespaced as
 * `platform.<key>`); they are stored per network so no cross-network
 * equivalence is implied (SocialMetric.semantics = "<network>.<metric>").
 */
export async function ingestPublicationMetrics(ctx: ServiceContext, pub: SocialPublicationRow): Promise<number> {
  if (!pub.providerPostId) return 0;
  if (!ctx.router.supports(pub.provider, pub.network as SocialNetwork, "analytics")) return 0;
  const provider = ctx.providers.get(pub.provider);
  if (!provider.getMetrics) return 0;
  const results = await provider.getMetrics(pub.providerPostId);
  const targets = await ctx.db
    .select({ target: socialPostTargets, externalId: providerAccounts.externalId })
    .from(socialPostTargets)
    .innerJoin(providerAccounts, and(eq(providerAccounts.connectionId, socialPostTargets.connectionId), eq(providerAccounts.workspaceId, pub.workspaceId)))
    .where(and(eq(socialPostTargets.publicationId, pub.id), eq(socialPostTargets.workspaceId, pub.workspaceId), eq(socialPostTargets.status, "published")));
  const byAccount = new Map(targets.map((t) => [t.externalId, t.target]));
  const measuredAt = ctx.now();
  const rows = [];
  for (const r of results) {
    const t = byAccount.get(r.accountExternalId);
    if (!t) continue; // metrics for accounts outside this publication/workspace are discarded
    for (const m of r.metrics) {
      rows.push({
        workspaceId: pub.workspaceId,
        connectionId: t.connectionId,
        postId: pub.postId,
        targetId: t.id,
        network: t.network,
        metric: m.name,
        value: m.value,
        provider: pub.provider,
        measuredAt,
      });
    }
  }
  if (rows.length) await ctx.db.insert(socialMetrics).values(rows).onConflictDoNothing();
  await ctx.db.update(socialPublications).set({ metricsFetchedAt: measuredAt }).where(eq(socialPublications.id, pub.id));
  return rows.length;
}

/** Worker: refresh metrics for recently published publications (at most every 6h each). */
export async function ingestDueMetrics(ctx: ServiceContext, limit = 50): Promise<number> {
  const now = ctx.now();
  const pubs = await ctx.db
    .select()
    .from(socialPublications)
    .where(
      and(
        inArray(socialPublications.status, ["published", "partially_published"]),
        isNotNull(socialPublications.providerPostId),
        gt(socialPublications.publishAt, new Date(now.getTime() - METRICS_WINDOW_MS)),
        or(isNull(socialPublications.metricsFetchedAt), lt(socialPublications.metricsFetchedAt, new Date(now.getTime() - METRICS_REFRESH_MS))),
      ),
    )
    .limit(limit);
  let n = 0;
  for (const p of pubs) {
    try {
      n += await ingestPublicationMetrics(ctx, p);
    } catch (err) {
      ctx.logger.warn({ publicationId: p.id, err }, "metrics ingestion failed");
    }
  }
  return n;
}

/** GET /v1/metrics — latest snapshot per (target, metric) unless history is requested. */
export async function queryMetrics(
  ctx: ServiceContext,
  actor: Actor,
  q: { postId?: string; connectionId?: string; history?: boolean; limit: number },
): Promise<SocialMetric[]> {
  const ws = actor.workspace;
  if (!q.postId && !q.connectionId) throw new SocialError("VALIDATION_ERROR", "postId or connectionId is required");
  const conds = [eq(socialMetrics.workspaceId, ws.id)];
  if (q.postId) {
    assertUuid(q.postId, "POST_NOT_FOUND");
    conds.push(eq(socialMetrics.postId, q.postId));
  }
  if (q.connectionId) {
    assertUuid(q.connectionId, "CONNECTION_NOT_FOUND");
    const c = await getConnectionForWorkspace(ctx.db, ws.id, q.connectionId);
    ctx.router.assert(c.connection.provider, c.connection.network as SocialNetwork, "analytics");
    conds.push(eq(socialMetrics.connectionId, q.connectionId));
  }
  const rows = await ctx.db
    .select()
    .from(socialMetrics)
    .where(and(...conds))
    .orderBy(desc(socialMetrics.measuredAt))
    .limit(q.history ? q.limit : 5000);
  if (q.history) return rows.map((r) => toMetric(r, ws));
  const seen = new Set<string>();
  const latest = rows.filter((r) => {
    const k = `${r.targetId}|${r.metric}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return latest.slice(0, q.limit).map((r) => toMetric(r, ws));
}

/** POST /v1/posts/:id/metrics/refresh — synchronous refresh for one post's publications. */
export async function refreshPostMetrics(ctx: ServiceContext, actor: Actor, postId: string): Promise<SocialMetric[]> {
  assertUuid(postId, "POST_NOT_FOUND");
  const pubs = await ctx.db
    .select()
    .from(socialPublications)
    .where(and(eq(socialPublications.postId, postId), eq(socialPublications.workspaceId, actor.workspace.id)));
  // Unknown (or other-workspace) post → POST_NOT_FOUND.
  if (pubs.length === 0) await getPost(ctx, actor, postId);
  for (const p of pubs.filter((x) => x.status === "published" || x.status === "partially_published")) {
    try {
      await ingestPublicationMetrics(ctx, p);
    } catch (err) {
      throw toSocialError(err);
    }
  }
  return queryMetrics(ctx, actor, { postId, limit: 1000 });
}
