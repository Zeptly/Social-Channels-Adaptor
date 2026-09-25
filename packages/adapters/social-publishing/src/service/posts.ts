import { GatewayError } from "@zeptly-gateway/gateway-contract";
import {
  type Executor,
  type SocialPostRow,
  socialPosts,
  type SocialPostTargetRow,
  socialPostTargets,
  socialPublications,
  socialSchedules,
  type Workspace,
} from "@zeptly-gateway/database";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type Actor, assertUuid, getConnectionsForWorkspace, recordAudit, requestHash, stableStringify, toGatewayError } from "@zeptly-gateway/gateway-core";
import type {
  CreatePostRequest,
  SchedulePostRequest,
  SocialContent,
  SocialNetwork,
  SocialPost,
  SocialPostTargetInput,
  SocialPublication,
  UpdatePostRequest,
} from "../contract/index.js";
import type { SocialPublishingContext } from "./context.js";
import { applyRemoteState, handoffHorizonEnd, recomputePostStatus, runHandoff } from "./dispatch.js";
import { loadWorkspaceMedia, resolveProviderMedia } from "./media.js";
import { toPost, toPublication } from "./serializers.js";
import { validateTargetContent } from "./validation.js";

/** Upper bound for canonical schedules (sanity; Zeptly owns long-range planning). */
export const MAX_SCHEDULE_AHEAD_MS = 2 * 365 * 86_400_000;
export const MIN_SCHEDULE_AHEAD_MS = 60_000;

async function loadPost(db: Executor, ws: Workspace, id: string): Promise<{ post: SocialPostRow; targets: SocialPostTargetRow[] }> {
  assertUuid(id, "POST_NOT_FOUND");
  const [post] = await db.select().from(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.workspaceId, ws.id))).limit(1);
  if (!post) throw new GatewayError("POST_NOT_FOUND", "Post not found");
  const targets = await db.select().from(socialPostTargets).where(and(eq(socialPostTargets.postId, post.id), eq(socialPostTargets.workspaceId, ws.id)));
  return { post, targets };
}

export async function getPost(ctx: SocialPublishingContext, actor: Actor, id: string): Promise<SocialPost> {
  const { post, targets } = await loadPost(ctx.db, actor.workspace, id);
  return toPost(post, targets, actor.workspace);
}

export async function listPosts(ctx: SocialPublishingContext, actor: Actor, q: { limit: number; cursor?: string; status?: string }): Promise<{ data: SocialPost[]; nextCursor?: string }> {
  const conds = [eq(socialPosts.workspaceId, actor.workspace.id)];
  if (q.status) conds.push(eq(socialPosts.status, q.status));
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, "base64url").toString().split("|");
    const d = new Date(ts ?? "");
    if (!id || Number.isNaN(d.getTime())) throw new GatewayError("VALIDATION_ERROR", "Invalid cursor");
    const c = or(lt(socialPosts.createdAt, d), and(eq(socialPosts.createdAt, d), lt(socialPosts.id, id)));
    if (c) conds.push(c);
  }
  const rows = await ctx.db
    .select()
    .from(socialPosts)
    .where(and(...conds))
    .orderBy(desc(socialPosts.createdAt), desc(socialPosts.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const targets = page.length ? await ctx.db.select().from(socialPostTargets).where(inArray(socialPostTargets.postId, page.map((p) => p.id))) : [];
  const last = page[page.length - 1];
  return {
    data: page.map((p) => toPost(p, targets.filter((t) => t.postId === p.id), actor.workspace)),
    ...(rows.length > q.limit && last ? { nextCursor: Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url") } : {}),
  };
}

/**
 * POST /v1/posts. Idempotent on (workspace, Idempotency-Key): the same key and
 * body returns the original post; the same key with a different body is an
 * IDEMPOTENCY_CONFLICT. Every connection is re-validated against the calling
 * workspace (never trusted because it exists).
 */
export async function createPost(ctx: SocialPublishingContext, actor: Actor, req: CreatePostRequest, idempotencyKey: string): Promise<{ post: SocialPost; replayed: boolean }> {
  const ws = actor.workspace;
  const hash = requestHash(req);
  const existing = await ctx.db.select().from(socialPosts).where(and(eq(socialPosts.workspaceId, ws.id), eq(socialPosts.idempotencyKey, idempotencyKey))).limit(1);
  if (existing[0]) {
    if (existing[0].requestHash !== hash) throw new GatewayError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request");
    const targets = await ctx.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, existing[0].id));
    return { post: toPost(existing[0], targets, ws), replayed: true };
  }

  const conns = await validatePostTargets(ctx, ws, req.content, req.targets);

  const created = await ctx.db.transaction(async (tx) => {
    const [post] = await tx
      .insert(socialPosts)
      .values({
        workspaceId: ws.id,
        status: "draft",
        content: req.content,
        externalRef: req.externalRef ?? null,
        idempotencyKey,
        requestHash: hash,
        createdBy: actor.agent ?? actor.service,
      })
      .onConflictDoNothing()
      .returning();
    if (!post) return null;
    const targets = await tx
      .insert(socialPostTargets)
      .values(
        req.targets.map((t) => ({
          workspaceId: ws.id,
          postId: post.id,
          connectionId: t.connectionId,
          network: (conns.get(t.connectionId) as NonNullable<ReturnType<typeof conns.get>>).connection.network,
          content: t.content ?? null,
          options: t.options ?? null,
          status: "pending",
        })),
      )
      .returning();
    await recordAudit(tx, actor, { workspaceId: ws.id, action: "post.accepted", resourceType: "post", resourceId: post.id, metadata: { targets: targets.length, externalRef: req.externalRef } });
    return { post, targets };
  });
  if (!created) return createPost(ctx, actor, req, idempotencyKey); // concurrent duplicate: replay
  return { post: toPost(created.post, created.targets, ws), replayed: false };
}

/**
 * Validate targets against the calling workspace's connections, capabilities
 * and verified network constraints (shared by create and update).
 */
async function validatePostTargets(ctx: SocialPublishingContext, ws: Workspace, content: SocialContent, targets: SocialPostTargetInput[]) {
  const req = { content, targets };
  const connectionIds = req.targets.map((t) => t.connectionId);
  if (new Set(connectionIds).size !== connectionIds.length) throw new GatewayError("TARGET_INVALID", "Each connection may be targeted once per post");
  const conns = await getConnectionsForWorkspace(ctx.db, ws.id, connectionIds);
  const missing = connectionIds.filter((id) => !conns.has(id));
  if (missing.length) throw new GatewayError("CONNECTION_NOT_FOUND", "Connection not found", { details: { connectionIds: missing } });

  const allMediaIds = [...new Set([...(req.content.mediaIds ?? []), ...req.targets.flatMap((t) => t.content?.mediaIds ?? [])])];
  const media = await loadWorkspaceMedia(ctx.db, ws.id, allMediaIds);

  const problems: string[] = [];
  for (const t of req.targets) {
    const { connection } = conns.get(t.connectionId) as NonNullable<ReturnType<typeof conns.get>>;
    const network = connection.network as SocialNetwork;
    if (connection.status === "disconnected") {
      problems.push(`${network}: connection ${connection.id} is disconnected`);
      continue;
    }
    if (!ctx.socialCatalog.supports(network, "publish")) {
      throw new GatewayError("CAPABILITY_NOT_SUPPORTED", `The publish capability is not supported for ${network}`, { details: { network, capability: "publish" } });
    }
    const descriptor = ctx.socialCatalog.describe(network);
    if (!descriptor) throw new GatewayError("NETWORK_NOT_SUPPORTED", "Network is not supported");
    const text = t.content?.text ?? req.content.text ?? "";
    const mediaIds = t.content?.mediaIds ?? req.content.mediaIds ?? [];
    problems.push(
      ...validateTargetContent(network, descriptor.constraints, {
        text,
        media: mediaIds.map((id) => {
          const m = media.get(id);
          if (!m) throw new GatewayError("MEDIA_NOT_FOUND", "Media not found", { details: { mediaIds: [id] } });
          return { id, kind: m.kind as "image" | "video", contentType: m.contentType, sizeBytes: m.sizeBytes, status: m.status };
        }),
        options: t.options ?? {},
      }),
    );
  }
  if (problems.length) throw new GatewayError("VALIDATION_ERROR", "Post content is not valid for one or more targets", { details: { problems } });
  return conns;
}

interface PublicationGroup {
  network: string;
  provider: string;
  text: string;
  mediaIds: string[];
  options: Record<string, unknown>;
  targetIds: string[];
}

/** Targets sharing network + effective content + options become one provider submission. */
function groupTargets(post: SocialPostRow, targets: SocialPostTargetRow[], providerFor: (t: SocialPostTargetRow) => string): PublicationGroup[] {
  const groups = new Map<string, PublicationGroup>();
  for (const t of targets) {
    const text = t.content?.text ?? post.content.text ?? "";
    const mediaIds = t.content?.mediaIds ?? post.content.mediaIds ?? [];
    const options = t.options ?? {};
    const provider = providerFor(t);
    const key = stableStringify({ network: t.network, provider, text, mediaIds, options });
    const g = groups.get(key);
    if (g) g.targetIds.push(t.id);
    else groups.set(key, { network: t.network, provider, text, mediaIds, options, targetIds: [t.id] });
  }
  return [...groups.values()];
}

async function createPublications(
  tx: Executor,
  post: SocialPostRow,
  targets: SocialPostTargetRow[],
  providerFor: (t: SocialPostTargetRow) => string,
  opts: { mode: "immediate" | "scheduled"; publishAt: Date; targetStatus: "pending" | "scheduled" },
): Promise<string[]> {
  const ids: string[] = [];
  for (const g of groupTargets(post, targets, providerFor)) {
    const [pub] = await tx
      .insert(socialPublications)
      .values({
        workspaceId: post.workspaceId,
        postId: post.id,
        provider: g.provider,
        network: g.network,
        snapshot: { text: g.text, mediaIds: g.mediaIds, options: g.options },
        mode: opts.mode,
        status: "pending",
        publishAt: opts.publishAt,
      })
      .returning({ id: socialPublications.id });
    if (!pub) throw new GatewayError("INTERNAL_ERROR", "Could not create publication");
    ids.push(pub.id);
    await tx
      .update(socialPostTargets)
      .set({ publicationId: pub.id, status: opts.targetStatus, errorCode: null, errorMessage: null, updatedAt: new Date() })
      .where(and(inArray(socialPostTargets.id, g.targetIds), eq(socialPostTargets.workspaceId, post.workspaceId)));
  }
  return ids;
}

async function assertCapability(ctx: SocialPublishingContext, ws: Workspace, targets: SocialPostTargetRow[], capability: "publish" | "schedule"): Promise<Map<string, string>> {
  const conns = await getConnectionsForWorkspace(ctx.db, ws.id, targets.map((t) => t.connectionId));
  const providerByTarget = new Map<string, string>();
  let active = 0;
  for (const t of targets) {
    const c = conns.get(t.connectionId);
    if (!c) throw new GatewayError("CONNECTION_NOT_FOUND", "Connection not found", { details: { connectionId: t.connectionId } });
    ctx.socialCatalog.assert(t.network, capability);
    providerByTarget.set(t.id, c.connection.provider);
    if (c.connection.status === "connected" || c.connection.status === "degraded") active++;
  }
  if (active === 0) {
    const reauth = targets.some((t) => conns.get(t.connectionId)?.connection.status === "reauthorization_required");
    throw new GatewayError(reauth ? "REAUTHORIZATION_REQUIRED" : "CONNECTION_NOT_ACTIVE", "No target connection is currently active");
  }
  return providerByTarget;
}

/** POST /v1/posts/:id/publish — queue immediate publication (idempotent: re-publishing is a no-op). */
export async function publishPost(ctx: SocialPublishingContext, actor: Actor, id: string): Promise<SocialPost> {
  const ws = actor.workspace;
  const { post, targets } = await loadPost(ctx.db, ws, id);
  if (["queued", "publishing", "published", "partially_published"].includes(post.status)) return toPost(post, targets, ws);
  if (post.status !== "draft") {
    throw new GatewayError("INVALID_STATE", `Post cannot be published from status ${post.status}`, { details: { status: post.status } });
  }
  const providerByTarget = await assertCapability(ctx, ws, targets, "publish");
  const now = ctx.now();
  const pubIds = await ctx.db.transaction(async (tx) => {
    const locked = await tx.update(socialPosts).set({ status: "queued", updatedAt: now }).where(and(eq(socialPosts.id, post.id), eq(socialPosts.status, "draft"))).returning();
    if (locked.length === 0) return [];
    const ids = await createPublications(tx, post, targets, (t) => providerByTarget.get(t.id) as string, { mode: "immediate", publishAt: now, targetStatus: "pending" });
    await recordAudit(tx, actor, { workspaceId: ws.id, action: "publication.requested", resourceType: "post", resourceId: post.id, metadata: { publications: ids.length, mode: "immediate" } });
    return ids;
  });
  if (pubIds.length && ctx.publishingSettings.inlineDispatch) await runHandoff(ctx, `api:${actor.requestId}`, { ids: pubIds });
  return getPost(ctx, actor, id);
}

/**
 * POST /v1/posts/:id/schedule — record the canonical schedule. Publications
 * are handed to the provider only once they enter the provider's scheduling
 * horizon (rolling hand-off). Rescheduling a handed-off post edits it in place
 * when the provider supports it (Outstand PATCH, feature-flagged), otherwise it
 * deletes the provider copy and recreates it.
 */
export async function schedulePost(ctx: SocialPublishingContext, actor: Actor, id: string, req: SchedulePostRequest): Promise<SocialPost> {
  const ws = actor.workspace;
  const scheduledAt = new Date(req.scheduledAt);
  const now = ctx.now();
  if (scheduledAt.getTime() < now.getTime() + MIN_SCHEDULE_AHEAD_MS) throw new GatewayError("VALIDATION_ERROR", "scheduledAt must be at least 60 seconds in the future");
  if (scheduledAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) throw new GatewayError("VALIDATION_ERROR", "scheduledAt is too far in the future");
  const { post } = await loadPost(ctx.db, ws, id);
  if (post.status !== "draft" && post.status !== "scheduled") {
    throw new GatewayError("INVALID_STATE", `Post cannot be scheduled from status ${post.status}`, { details: { status: post.status } });
  }
  await replanSchedule(ctx, actor, post, scheduledAt, req.timezone ?? null, post.status === "scheduled" ? "schedule.changed" : "schedule.created");
  return getPost(ctx, actor, id);
}

/**
 * PATCH /v1/posts/:id — edit copy, media, per-target variants/options (and the
 * target set) of a draft or scheduled post, keeping the same post id. Scheduled
 * posts are re-planned: handed-off provider copies are updated in place where
 * supported, otherwise replaced.
 */
export async function updatePost(ctx: SocialPublishingContext, actor: Actor, id: string, req: UpdatePostRequest): Promise<SocialPost> {
  const ws = actor.workspace;
  const { post, targets } = await loadPost(ctx.db, ws, id);
  if (post.status !== "draft" && post.status !== "scheduled") {
    throw new GatewayError("INVALID_STATE", `Post cannot be edited from status ${post.status}`, { details: { status: post.status } });
  }
  if (targets.some((t) => t.status === "published" || t.status === "publishing")) {
    throw new GatewayError("INVALID_STATE", "Part of this post is already publishing or published and cannot be edited");
  }
  const content = req.content ?? post.content;
  const nextTargets: SocialPostTargetInput[] =
    req.targets ??
    targets.map((t) => ({ connectionId: t.connectionId, ...(t.content ? { content: t.content } : {}), ...(t.options ? { options: t.options } : {}) }));
  const conns = await validatePostTargets(ctx, ws, content, nextTargets);
  const now = ctx.now();
  const updated = await ctx.db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(socialPosts).where(eq(socialPosts.id, post.id)).for("update");
    if (!fresh || fresh.status !== post.status) throw new GatewayError("INVALID_STATE", "Post state changed concurrently; retry", { retryable: true });
    const [row] = await tx
      .update(socialPosts)
      .set({ content, ...(req.externalRef !== undefined ? { externalRef: req.externalRef } : {}), updatedAt: now })
      .where(eq(socialPosts.id, post.id))
      .returning();
    const byConnection = new Map(targets.map((t) => [t.connectionId, t]));
    const wanted = new Set(nextTargets.map((t) => t.connectionId));
    for (const t of nextTargets) {
      const existing = byConnection.get(t.connectionId);
      if (existing) {
        await tx.update(socialPostTargets).set({ content: t.content ?? null, options: t.options ?? null, updatedAt: now }).where(eq(socialPostTargets.id, existing.id));
      } else {
        await tx.insert(socialPostTargets).values({
          workspaceId: ws.id,
          postId: post.id,
          connectionId: t.connectionId,
          network: (conns.get(t.connectionId) as NonNullable<ReturnType<typeof conns.get>>).connection.network,
          content: t.content ?? null,
          options: t.options ?? null,
          status: post.status === "scheduled" ? "scheduled" : "pending",
        });
      }
    }
    const removed = targets.filter((t) => !wanted.has(t.connectionId)).map((t) => t.id);
    // Removed targets are detached here; their provider copies are cancelled by the re-plan below.
    if (removed.length) await tx.update(socialPostTargets).set({ status: "cancelled", updatedAt: now }).where(inArray(socialPostTargets.id, removed));
    await recordAudit(tx, actor, {
      workspaceId: ws.id,
      action: "post.updated",
      resourceType: "post",
      resourceId: post.id,
      metadata: { targets: nextTargets.length, removed: removed.length, status: post.status },
    });
    return row ?? post;
  });
  if (updated.status === "scheduled" && updated.scheduledAt) {
    await replanSchedule(ctx, actor, updated, updated.scheduledAt, updated.timezone, "schedule.content_changed");
    // Drop detached targets from the post once their publications are cancelled.
    await ctx.db.delete(socialPostTargets).where(and(eq(socialPostTargets.postId, post.id), eq(socialPostTargets.status, "cancelled")));
  } else {
    await ctx.db.delete(socialPostTargets).where(and(eq(socialPostTargets.postId, post.id), eq(socialPostTargets.status, "cancelled")));
  }
  return getPost(ctx, actor, id);
}

/**
 * Bring a post's publications in line with its current content, targets and
 * schedule. Handed-off provider posts whose target set is unchanged are updated
 * in place when the provider supports it; everything else not yet published is
 * cancelled (provider copy deleted) and recreated.
 */
async function replanSchedule(ctx: SocialPublishingContext, actor: Actor, post: SocialPostRow, scheduledAt: Date, timezone: string | null, auditAction: string): Promise<void> {
  const ws = actor.workspace;
  const now = ctx.now();
  const liveTargets = (await ctx.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, post.id))).filter((t) => t.status !== "cancelled");
  const providerByTarget = await assertCapability(ctx, ws, liveTargets, "schedule");
  const providerFor = (t: SocialPostTargetRow) => providerByTarget.get(t.id) as string;
  const kept = post.status === "scheduled" ? await updateHandedOffInPlace(ctx, actor, post, liveTargets, providerFor, scheduledAt) : new Set<string>();
  if (post.status === "scheduled") await cancelOpenPublications(ctx, actor, post, "reschedule", kept);

  const pubIds = await ctx.db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(socialPosts).where(eq(socialPosts.id, post.id)).for("update");
    if (!fresh || (fresh.status !== "draft" && fresh.status !== "scheduled")) throw new GatewayError("INVALID_STATE", "Post state changed concurrently");
    const current = (await tx.select().from(socialPostTargets).where(eq(socialPostTargets.postId, post.id))).filter(
      (t) => t.status !== "cancelled" && !(t.publicationId && kept.has(t.publicationId)),
    );
    const ids = await createPublications(tx, fresh, current, providerFor, { mode: "scheduled", publishAt: scheduledAt, targetStatus: "scheduled" });
    await tx.update(socialPosts).set({ status: "scheduled", scheduledAt, timezone, updatedAt: now }).where(eq(socialPosts.id, post.id));
    await tx
      .insert(socialSchedules)
      .values({ workspaceId: ws.id, postId: post.id, scheduledAt, timezone, status: "active" })
      .onConflictDoUpdate({
        target: socialSchedules.postId,
        set: { scheduledAt, timezone, status: "active", revision: sqlIncrement(), updatedAt: now },
      });
    await recordAudit(tx, actor, {
      workspaceId: ws.id,
      action: auditAction,
      resourceType: "post",
      resourceId: post.id,
      metadata: { scheduledAt: scheduledAt.toISOString(), previous: post.scheduledAt?.toISOString(), timezone, updatedInPlace: kept.size },
    });
    return ids;
  });
  if (pubIds.length && ctx.publishingSettings.inlineDispatch) await runHandoff(ctx, `api:${actor.requestId}`, { ids: pubIds });
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Returns the ids of handed-off publications that were updated in place at the provider. */
async function updateHandedOffInPlace(
  ctx: SocialPublishingContext,
  actor: Actor,
  post: SocialPostRow,
  targets: SocialPostTargetRow[],
  providerFor: (t: SocialPostTargetRow) => string,
  publishAt: Date,
): Promise<Set<string>> {
  const kept = new Set<string>();
  const pubs = await ctx.db
    .select()
    .from(socialPublications)
    .where(and(eq(socialPublications.postId, post.id), eq(socialPublications.workspaceId, post.workspaceId), eq(socialPublications.status, "accepted")));
  if (pubs.length === 0) return kept;
  const groups = groupTargets(post, targets, providerFor);
  for (const pub of pubs) {
    if (!pub.providerPostId) continue;
    const provider = ctx.publishing;
    if (!provider.supportsPostUpdate || !provider.updatePost) continue;
    if (publishAt.getTime() > handoffHorizonEnd(ctx.now(), provider.schedulingHorizonMs, ctx.publishingSettings.handoffMarginMs).getTime()) continue;
    const pubTargetIds = targets.filter((t) => t.publicationId === pub.id).map((t) => t.id);
    const group = groups.find((g) => g.provider === pub.provider && sameSet(g.targetIds, pubTargetIds));
    if (!group) continue;
    try {
      const media = await resolveProviderMedia(ctx, pub.workspaceId, group.mediaIds, publishAt);
      const remote = await provider.updatePost(pub.providerPostId, {
        network: group.network as SocialNetwork,
        text: group.text,
        media,
        options: group.options,
        scheduledAt: publishAt,
      });
      const snapshot = { text: group.text, mediaIds: group.mediaIds, options: group.options };
      await ctx.db.update(socialPublications).set({ snapshot, publishAt, updatedAt: ctx.now() }).where(eq(socialPublications.id, pub.id));
      await applyRemoteState(ctx, { ...pub, snapshot, publishAt }, remote, { source: "reconcile" });
      await recordAudit(ctx.db, actor, { workspaceId: post.workspaceId, action: "publication.updated_in_place", resourceType: "publication", resourceId: pub.id, metadata: { postId: post.id } });
      kept.add(pub.id);
    } catch (err) {
      // Any failure falls back to the verified delete + recreate path.
      ctx.logger.warn({ publicationId: pub.id, err }, "in-place provider update failed; falling back to delete + recreate");
    }
  }
  return kept;
}

function sqlIncrement() {
  return sql`${socialSchedules.revision} + 1`;
}

/**
 * Cancel every not-yet-terminal publication of a post (except `keep`). Provider
 * copies that were already handed off are deleted at the provider first
 * (capability `delete`). A publication currently being dispatched makes the
 * call fail with INVALID_STATE (retry shortly).
 */
async function cancelOpenPublications(ctx: SocialPublishingContext, actor: Actor, post: SocialPostRow, reason: "reschedule" | "cancel", keep: Set<string> = new Set()): Promise<void> {
  const pubs = (
    await ctx.db
      .select()
      .from(socialPublications)
      .where(and(eq(socialPublications.postId, post.id), eq(socialPublications.workspaceId, post.workspaceId), inArray(socialPublications.status, ["pending", "retry_pending", "dispatching", "accepted"])))
  ).filter((p) => !keep.has(p.id));
  if (pubs.some((p) => p.status === "dispatching")) {
    throw new GatewayError("INVALID_STATE", "The post is being handed to the provider right now; retry shortly", { retryable: true });
  }
  for (const pub of pubs) {
    if (pub.status === "accepted" && pub.providerPostId) {
      const publishedTargets = await ctx.db
        .select({ id: socialPostTargets.id })
        .from(socialPostTargets)
        .where(and(eq(socialPostTargets.publicationId, pub.id), eq(socialPostTargets.status, "published")));
      if (publishedTargets.length) throw new GatewayError("INVALID_STATE", "Part of this post is already published and cannot be rescheduled or cancelled");
      ctx.socialCatalog.assert(pub.network, "delete");
      try {
        await ctx.publishing.deletePost(pub.providerPostId);
      } catch (err) {
        throw toGatewayError(err);
      }
    }
    await ctx.db.transaction(async (tx) => {
      const updated = await tx
        .update(socialPublications)
        .set({ status: "cancelled", lockedBy: null, lockedAt: null, updatedAt: ctx.now() })
        .where(and(eq(socialPublications.id, pub.id), inArray(socialPublications.status, ["pending", "retry_pending", "accepted"])))
        .returning({ id: socialPublications.id });
      if (updated.length === 0) throw new GatewayError("INVALID_STATE", "Publication state changed concurrently; retry", { retryable: true });
      await tx
        .update(socialPostTargets)
        .set({ status: reason === "cancel" ? "cancelled" : "pending", publicationId: reason === "cancel" ? pub.id : null, updatedAt: ctx.now() })
        .where(and(eq(socialPostTargets.publicationId, pub.id), inArray(socialPostTargets.status, ["pending", "scheduled", "publishing"])));
      await recordAudit(tx, actor, { workspaceId: post.workspaceId, action: `publication.cancelled`, resourceType: "publication", resourceId: pub.id, metadata: { reason, postId: post.id } });
    });
  }
}

/** POST /v1/posts/:id/cancel — cancel everything not yet published. */
export async function cancelPost(ctx: SocialPublishingContext, actor: Actor, id: string): Promise<SocialPost> {
  const ws = actor.workspace;
  const { post } = await loadPost(ctx.db, ws, id);
  if (post.status === "cancelled") return getPost(ctx, actor, id);
  if (post.status === "published" || post.status === "failed" || post.status === "partially_published") {
    throw new GatewayError("INVALID_STATE", `Post cannot be cancelled from status ${post.status}`, { details: { status: post.status } });
  }
  await cancelOpenPublications(ctx, actor, post, "cancel");
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(socialPostTargets)
      .set({ status: "cancelled", updatedAt: ctx.now() })
      .where(and(eq(socialPostTargets.postId, post.id), inArray(socialPostTargets.status, ["pending", "scheduled", "publishing"])));
    const targets = await tx.select({ status: socialPostTargets.status }).from(socialPostTargets).where(eq(socialPostTargets.postId, post.id));
    const anyPublished = targets.some((t) => t.status === "published");
    if (anyPublished) await recomputePostStatus(tx, post.id, ws.id, { service: "worker", requestId: actor.requestId });
    else await tx.update(socialPosts).set({ status: "cancelled", cancelledAt: ctx.now(), updatedAt: ctx.now() }).where(eq(socialPosts.id, post.id));
    await tx.update(socialSchedules).set({ status: "cancelled", updatedAt: ctx.now() }).where(eq(socialSchedules.postId, post.id));
    await recordAudit(tx, actor, { workspaceId: ws.id, action: "post.cancelled", resourceType: "post", resourceId: post.id, metadata: { previous: post.status } });
  });
  return getPost(ctx, actor, id);
}

export async function listPublications(ctx: SocialPublishingContext, actor: Actor, id: string): Promise<SocialPublication[]> {
  const { post, targets } = await loadPost(ctx.db, actor.workspace, id);
  const pubs = await ctx.db
    .select()
    .from(socialPublications)
    .where(and(eq(socialPublications.postId, post.id), eq(socialPublications.workspaceId, actor.workspace.id)))
    .orderBy(socialPublications.createdAt);
  return pubs.map((p) =>
    toPublication(
      p,
      targets.filter((t) => t.publicationId === p.id).map((t) => t.id),
    ),
  );
}
