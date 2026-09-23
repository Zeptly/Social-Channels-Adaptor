import { createHash } from "node:crypto";
import {
  type CreatePostRequest,
  type SchedulePostRequest,
  SocialError,
  type SocialNetwork,
  type SocialPost,
  type SocialPublication,
} from "@zeptly-social/domain";
import {
  type Executor,
  type SocialPostRow,
  socialPosts,
  type SocialPostTargetRow,
  socialPostTargets,
  socialPublications,
  socialSchedules,
  type Workspace,
} from "@zeptly-social/database";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import type { Actor, ServiceContext } from "./context.js";
import { recomputePostStatus, runHandoff } from "./dispatch.js";
import { loadWorkspaceMedia } from "./media.js";
import { toSocialError } from "./provider-errors.js";
import { toPost, toPublication } from "./serializers.js";
import { assertUuid, getConnectionsForWorkspace } from "./tenancy.js";
import { validateTargetContent } from "./validation.js";

/** Upper bound for canonical schedules (sanity; Zeptly owns long-range planning). */
export const MAX_SCHEDULE_AHEAD_MS = 2 * 365 * 86_400_000;
export const MIN_SCHEDULE_AHEAD_MS = 60_000;

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export const requestHash = (v: unknown) => createHash("sha256").update(stableStringify(v)).digest("hex");

async function loadPost(db: Executor, ws: Workspace, id: string): Promise<{ post: SocialPostRow; targets: SocialPostTargetRow[] }> {
  assertUuid(id, "POST_NOT_FOUND");
  const [post] = await db.select().from(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.workspaceId, ws.id))).limit(1);
  if (!post) throw new SocialError("POST_NOT_FOUND", "Post not found");
  const targets = await db.select().from(socialPostTargets).where(and(eq(socialPostTargets.postId, post.id), eq(socialPostTargets.workspaceId, ws.id)));
  return { post, targets };
}

export async function getPost(ctx: ServiceContext, actor: Actor, id: string): Promise<SocialPost> {
  const { post, targets } = await loadPost(ctx.db, actor.workspace, id);
  return toPost(post, targets, actor.workspace);
}

export async function listPosts(ctx: ServiceContext, actor: Actor, q: { limit: number; cursor?: string; status?: string }): Promise<{ data: SocialPost[]; nextCursor?: string }> {
  const conds = [eq(socialPosts.workspaceId, actor.workspace.id)];
  if (q.status) conds.push(eq(socialPosts.status, q.status));
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, "base64url").toString().split("|");
    const d = new Date(ts ?? "");
    if (!id || Number.isNaN(d.getTime())) throw new SocialError("VALIDATION_ERROR", "Invalid cursor");
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
export async function createPost(ctx: ServiceContext, actor: Actor, req: CreatePostRequest, idempotencyKey: string): Promise<{ post: SocialPost; replayed: boolean }> {
  const ws = actor.workspace;
  const hash = requestHash(req);
  const existing = await ctx.db.select().from(socialPosts).where(and(eq(socialPosts.workspaceId, ws.id), eq(socialPosts.idempotencyKey, idempotencyKey))).limit(1);
  if (existing[0]) {
    if (existing[0].requestHash !== hash) throw new SocialError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request");
    const targets = await ctx.db.select().from(socialPostTargets).where(eq(socialPostTargets.postId, existing[0].id));
    return { post: toPost(existing[0], targets, ws), replayed: true };
  }

  const connectionIds = req.targets.map((t) => t.connectionId);
  if (new Set(connectionIds).size !== connectionIds.length) throw new SocialError("TARGET_INVALID", "Each connection may be targeted once per post");
  const conns = await getConnectionsForWorkspace(ctx.db, ws.id, connectionIds);
  const missing = connectionIds.filter((id) => !conns.has(id));
  if (missing.length) throw new SocialError("CONNECTION_NOT_FOUND", "Connection not found", { details: { connectionIds: missing } });

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
    if (!ctx.router.supports(connection.provider, network, "publish")) {
      throw new SocialError("CAPABILITY_NOT_SUPPORTED", `The publish capability is not supported for ${network}`, { details: { network, capability: "publish" } });
    }
    const descriptor = ctx.router.describe(network);
    if (!descriptor) throw new SocialError("NETWORK_NOT_SUPPORTED", "Network is not supported");
    const text = t.content?.text ?? req.content.text ?? "";
    const mediaIds = t.content?.mediaIds ?? req.content.mediaIds ?? [];
    problems.push(
      ...validateTargetContent(network, descriptor.constraints, {
        text,
        media: mediaIds.map((id) => {
          const m = media.get(id);
          if (!m) throw new SocialError("MEDIA_NOT_FOUND", "Media not found", { details: { mediaIds: [id] } });
          return { id, kind: m.kind as "image" | "video", contentType: m.contentType, sizeBytes: m.sizeBytes, status: m.status };
        }),
        options: t.options ?? {},
      }),
    );
  }
  if (problems.length) throw new SocialError("VALIDATION_ERROR", "Post content is not valid for one or more targets", { details: { problems } });

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
    if (!pub) throw new SocialError("INTERNAL_ERROR", "Could not create publication");
    ids.push(pub.id);
    await tx
      .update(socialPostTargets)
      .set({ publicationId: pub.id, status: opts.targetStatus, errorCode: null, errorMessage: null, updatedAt: new Date() })
      .where(and(inArray(socialPostTargets.id, g.targetIds), eq(socialPostTargets.workspaceId, post.workspaceId)));
  }
  return ids;
}

async function assertCapability(ctx: ServiceContext, ws: Workspace, targets: SocialPostTargetRow[], capability: "publish" | "schedule"): Promise<Map<string, string>> {
  const conns = await getConnectionsForWorkspace(ctx.db, ws.id, targets.map((t) => t.connectionId));
  const providerByTarget = new Map<string, string>();
  let active = 0;
  for (const t of targets) {
    const c = conns.get(t.connectionId);
    if (!c) throw new SocialError("CONNECTION_NOT_FOUND", "Connection not found", { details: { connectionId: t.connectionId } });
    ctx.router.assert(c.connection.provider, t.network as SocialNetwork, capability);
    providerByTarget.set(t.id, c.connection.provider);
    if (c.connection.status === "connected" || c.connection.status === "degraded") active++;
  }
  if (active === 0) {
    const reauth = targets.some((t) => conns.get(t.connectionId)?.connection.status === "reauthorization_required");
    throw new SocialError(reauth ? "REAUTHORIZATION_REQUIRED" : "CONNECTION_NOT_ACTIVE", "No target connection is currently active");
  }
  return providerByTarget;
}

/** POST /v1/posts/:id/publish — queue immediate publication (idempotent: re-publishing is a no-op). */
export async function publishPost(ctx: ServiceContext, actor: Actor, id: string): Promise<SocialPost> {
  const ws = actor.workspace;
  const { post, targets } = await loadPost(ctx.db, ws, id);
  if (["queued", "publishing", "published", "partially_published"].includes(post.status)) return toPost(post, targets, ws);
  if (post.status !== "draft") {
    throw new SocialError("INVALID_STATE", `Post cannot be published from status ${post.status}`, { details: { status: post.status } });
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
  if (pubIds.length && ctx.settings.inlineDispatch) await runHandoff(ctx, `api:${actor.requestId}`, { ids: pubIds });
  return getPost(ctx, actor, id);
}

/**
 * POST /v1/posts/:id/schedule — record the canonical schedule. Publications
 * are handed to the provider only once they enter the provider's scheduling
 * horizon (rolling hand-off). Rescheduling cancels any not-yet-published
 * provider copy (delete + recreate; Outstand has no verified reschedule API).
 */
export async function schedulePost(ctx: ServiceContext, actor: Actor, id: string, req: SchedulePostRequest): Promise<SocialPost> {
  const ws = actor.workspace;
  const scheduledAt = new Date(req.scheduledAt);
  const now = ctx.now();
  if (scheduledAt.getTime() < now.getTime() + MIN_SCHEDULE_AHEAD_MS) throw new SocialError("VALIDATION_ERROR", "scheduledAt must be at least 60 seconds in the future");
  if (scheduledAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) throw new SocialError("VALIDATION_ERROR", "scheduledAt is too far in the future");
  const { post, targets } = await loadPost(ctx.db, ws, id);
  if (post.status !== "draft" && post.status !== "scheduled") {
    throw new SocialError("INVALID_STATE", `Post cannot be scheduled from status ${post.status}`, { details: { status: post.status } });
  }
  const providerByTarget = await assertCapability(ctx, ws, targets, "schedule");
  if (post.status === "scheduled") await cancelOpenPublications(ctx, actor, post, "reschedule");

  const pubIds = await ctx.db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(socialPosts).where(eq(socialPosts.id, post.id)).for("update");
    if (!fresh || (fresh.status !== "draft" && fresh.status !== "scheduled")) throw new SocialError("INVALID_STATE", "Post state changed concurrently");
    const current = await tx.select().from(socialPostTargets).where(eq(socialPostTargets.postId, post.id));
    const ids = await createPublications(tx, fresh, current, (t) => providerByTarget.get(t.id) as string, { mode: "scheduled", publishAt: scheduledAt, targetStatus: "scheduled" });
    await tx.update(socialPosts).set({ status: "scheduled", scheduledAt, timezone: req.timezone ?? null, updatedAt: now }).where(eq(socialPosts.id, post.id));
    await tx
      .insert(socialSchedules)
      .values({ workspaceId: ws.id, postId: post.id, scheduledAt, timezone: req.timezone ?? null, status: "active" })
      .onConflictDoUpdate({
        target: socialSchedules.postId,
        set: { scheduledAt, timezone: req.timezone ?? null, status: "active", revision: sqlIncrement(), updatedAt: now },
      });
    await recordAudit(tx, actor, {
      workspaceId: ws.id,
      action: post.status === "scheduled" ? "schedule.changed" : "schedule.created",
      resourceType: "post",
      resourceId: post.id,
      metadata: { scheduledAt: scheduledAt.toISOString(), previous: post.scheduledAt?.toISOString(), timezone: req.timezone },
    });
    return ids;
  });
  if (pubIds.length && ctx.settings.inlineDispatch) await runHandoff(ctx, `api:${actor.requestId}`, { ids: pubIds });
  return getPost(ctx, actor, id);
}

function sqlIncrement() {
  return sql`${socialSchedules.revision} + 1`;
}

/**
 * Cancel every not-yet-terminal publication of a post. Provider copies that were
 * already handed off are deleted at the provider first (capability `delete`).
 * A publication currently being dispatched makes the call fail with INVALID_STATE (retry shortly).
 */
async function cancelOpenPublications(ctx: ServiceContext, actor: Actor, post: SocialPostRow, reason: "reschedule" | "cancel"): Promise<void> {
  const pubs = await ctx.db
    .select()
    .from(socialPublications)
    .where(and(eq(socialPublications.postId, post.id), eq(socialPublications.workspaceId, post.workspaceId), inArray(socialPublications.status, ["pending", "retry_pending", "dispatching", "accepted"])));
  if (pubs.some((p) => p.status === "dispatching")) {
    throw new SocialError("INVALID_STATE", "The post is being handed to the provider right now; retry shortly", { retryable: true });
  }
  for (const pub of pubs) {
    if (pub.status === "accepted" && pub.providerPostId) {
      const publishedTargets = await ctx.db
        .select({ id: socialPostTargets.id })
        .from(socialPostTargets)
        .where(and(eq(socialPostTargets.publicationId, pub.id), eq(socialPostTargets.status, "published")));
      if (publishedTargets.length) throw new SocialError("INVALID_STATE", "Part of this post is already published and cannot be rescheduled or cancelled");
      ctx.router.assert(pub.provider, pub.network as SocialNetwork, "delete");
      try {
        await ctx.providers.get(pub.provider).deletePost(pub.providerPostId);
      } catch (err) {
        throw toSocialError(err);
      }
    }
    await ctx.db.transaction(async (tx) => {
      const updated = await tx
        .update(socialPublications)
        .set({ status: "cancelled", lockedBy: null, lockedAt: null, updatedAt: ctx.now() })
        .where(and(eq(socialPublications.id, pub.id), inArray(socialPublications.status, ["pending", "retry_pending", "accepted"])))
        .returning({ id: socialPublications.id });
      if (updated.length === 0) throw new SocialError("INVALID_STATE", "Publication state changed concurrently; retry", { retryable: true });
      await tx
        .update(socialPostTargets)
        .set({ status: reason === "cancel" ? "cancelled" : "pending", publicationId: reason === "cancel" ? pub.id : null, updatedAt: ctx.now() })
        .where(and(eq(socialPostTargets.publicationId, pub.id), inArray(socialPostTargets.status, ["pending", "scheduled", "publishing"])));
      await recordAudit(tx, actor, { workspaceId: post.workspaceId, action: `publication.cancelled`, resourceType: "publication", resourceId: pub.id, metadata: { reason, postId: post.id } });
    });
  }
}

/** POST /v1/posts/:id/cancel — cancel everything not yet published. */
export async function cancelPost(ctx: ServiceContext, actor: Actor, id: string): Promise<SocialPost> {
  const ws = actor.workspace;
  const { post } = await loadPost(ctx.db, ws, id);
  if (post.status === "cancelled") return getPost(ctx, actor, id);
  if (post.status === "published" || post.status === "failed" || post.status === "partially_published") {
    throw new SocialError("INVALID_STATE", `Post cannot be cancelled from status ${post.status}`, { details: { status: post.status } });
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

export async function listPublications(ctx: ServiceContext, actor: Actor, id: string): Promise<SocialPublication[]> {
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
