import { CapabilityRouter } from "@zeptly-social/capability-registry";
import { type MediaKind, type RegisterMediaRequest, type SocialMedia, SocialError } from "@zeptly-social/domain";
import { type Executor, type SocialMediaRow, socialMedia, type Workspace } from "@zeptly-social/database";
import type { ProviderMedia } from "@zeptly-social/provider-contract";
import { and, eq, inArray } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import type { Actor, ServiceContext } from "./context.js";
import { enqueueJob } from "./jobs.js";
import { safeMessage, toSocialError } from "./provider-errors.js";
import { toMedia } from "./serializers.js";
import { assertUuid } from "./tenancy.js";
import { assertPublicHttpsUrl } from "./url-safety.js";

/** Union of mime types / size limits across supported networks (per-network checks happen at post validation). */
function mediaPolicy(router: CapabilityRouter): Record<MediaKind, { mimeTypes: Set<string>; maxBytes: number }> {
  const policy = { image: { mimeTypes: new Set<string>(), maxBytes: 0 }, video: { mimeTypes: new Set<string>(), maxBytes: 0 } };
  for (const d of router.networks()) {
    for (const kind of ["image", "video"] as const) {
      const c = d.constraints[kind];
      if (!c) continue;
      c.mimeTypes.forEach((m) => policy[kind].mimeTypes.add(m));
      policy[kind].maxBytes = Math.max(policy[kind].maxBytes, c.maxSizeBytes ?? 0);
    }
  }
  // Networks without a documented cap still get a hard service ceiling.
  policy.image.maxBytes = Math.max(policy.image.maxBytes, 25 * 1024 * 1024);
  policy.video.maxBytes = Math.min(Math.max(policy.video.maxBytes, 1024 ** 3), 5 * 1024 ** 3);
  return policy;
}

export const MEDIA_POLICY = mediaPolicy(new CapabilityRouter());

export function mediaKindFor(contentType: string): MediaKind {
  const ct = contentType.toLowerCase();
  if (MEDIA_POLICY.image.mimeTypes.has(ct)) return "image";
  if (MEDIA_POLICY.video.mimeTypes.has(ct)) return "video";
  throw new SocialError("MEDIA_INVALID", "Unsupported media content type", { details: { contentType } });
}

/** Media is reusable by the provider until shortly before its provider-side expiry. */
const EXPIRY_SAFETY_MS = 60 * 60_000;

export async function registerMedia(ctx: ServiceContext, actor: Actor, req: RegisterMediaRequest): Promise<SocialMedia> {
  const contentType = req.contentType.toLowerCase();
  const kind = mediaKindFor(contentType);
  if (req.sizeBytes && req.sizeBytes > MEDIA_POLICY[kind].maxBytes) {
    throw new SocialError("MEDIA_INVALID", "Media exceeds the maximum supported size", { details: { maxBytes: MEDIA_POLICY[kind].maxBytes } });
  }
  const ws = actor.workspace;
  // Media is registered once and handed to the provider that serves media; in V1
  // every network's media capability resolves to the same provider.
  const mediaNetwork = ctx.router.networks().find((n) => n.capabilities.media)?.network;
  if (!mediaNetwork) throw new SocialError("CAPABILITY_NOT_SUPPORTED", "No provider supports media");
  const providerName = ctx.router.resolve({ capability: "media", network: mediaNetwork, workspaceId: ws.externalId });
  const provider = ctx.providers.get(providerName);

  if (req.source.type === "upload") {
    let prepared;
    try {
      prepared = await provider.prepareUpload({ filename: req.filename, contentType });
    } catch (err) {
      throw toSocialError(err);
    }
    const [row] = await ctx.db
      .insert(socialMedia)
      .values({
        workspaceId: ws.id,
        status: "pending_upload",
        kind,
        sourceType: "upload",
        filename: req.filename,
        contentType,
        sizeBytes: req.sizeBytes ?? null,
        provider: providerName,
        providerMediaId: prepared.externalId,
        uploadExpiresAt: prepared.expiresAt,
      })
      .returning();
    if (!row) throw new SocialError("INTERNAL_ERROR", "Media registration failed");
    await recordAudit(ctx.db, actor, { workspaceId: ws.id, action: "media.registered", resourceType: "media", resourceId: row.id, metadata: { sourceType: "upload", kind } });
    return toMedia(row, ws, prepared.uploadUrl);
  }

  const source = req.source;
  await assertPublicHttpsUrl(source.url, { skipDns: ctx.settings.skipMediaDnsCheck ?? false });
  const row = await ctx.db.transaction(async (tx) => {
    const [r] = await tx
      .insert(socialMedia)
      .values({
        workspaceId: ws.id,
        status: "processing",
        kind,
        sourceType: source.type,
        sourceUrl: source.url,
        assetRef: source.type === "asset" ? source.assetRef : null,
        filename: req.filename,
        contentType,
        sizeBytes: req.sizeBytes ?? null,
        provider: providerName,
      })
      .returning();
    if (!r) throw new SocialError("INTERNAL_ERROR", "Media registration failed");
    await enqueueJob(tx, "upload_media", { mediaId: r.id }, { dedupeKey: `upload_media:${r.id}`, workspaceId: ws.id, maxAttempts: 4, runAt: ctx.now() });
    await recordAudit(tx, actor, { workspaceId: ws.id, action: "media.registered", resourceType: "media", resourceId: r.id, metadata: { sourceType: source.type, kind } });
    return r;
  });
  return toMedia(row, ws);
}

/** Worker job: fetch the durable source URL and hand it to the provider. */
export async function processMediaUpload(ctx: ServiceContext, mediaId: string): Promise<void> {
  const [row] = await ctx.db.select().from(socialMedia).where(eq(socialMedia.id, mediaId)).limit(1);
  if (!row || row.status !== "processing" || !row.sourceUrl) return;
  try {
    const pm = await uploadFromSource(ctx, row);
    await ctx.db
      .update(socialMedia)
      .set({ status: "ready", providerMediaId: pm.externalId, providerUrl: pm.url, providerExpiresAt: pm.expiresAt ?? null, sizeBytes: pm.sizeBytes ?? row.sizeBytes, error: null, updatedAt: ctx.now() })
      .where(eq(socialMedia.id, row.id));
  } catch (err) {
    const se = toSocialError(err, "PROVIDER_UNAVAILABLE");
    if (se.retryable) throw err;
    await ctx.db.update(socialMedia).set({ status: "failed", error: safeMessage(err).slice(0, 500), updatedAt: ctx.now() }).where(eq(socialMedia.id, row.id));
  }
}

async function uploadFromSource(ctx: ServiceContext, row: SocialMediaRow): Promise<ProviderMedia> {
  if (!row.sourceUrl) throw new SocialError("MEDIA_INVALID", "Media has no durable source URL");
  await assertPublicHttpsUrl(row.sourceUrl, { skipDns: ctx.settings.skipMediaDnsCheck ?? false });
  const provider = ctx.providers.get(row.provider);
  return provider.uploadFromUrl({
    sourceUrl: row.sourceUrl,
    filename: row.filename,
    contentType: row.contentType,
    maxBytes: MEDIA_POLICY[row.kind as MediaKind].maxBytes,
  });
}

export async function completeMediaUpload(ctx: ServiceContext, actor: Actor, id: string, req: { sizeBytes?: number }): Promise<SocialMedia> {
  const row = await loadMedia(ctx.db, actor.workspace, id);
  if (row.status === "ready") return toMedia(row, actor.workspace);
  if (row.status !== "pending_upload" || !row.providerMediaId) throw new SocialError("INVALID_STATE", "Media is not awaiting an upload");
  const provider = ctx.providers.get(row.provider);
  let pm: ProviderMedia;
  try {
    pm = await provider.confirmUpload({ externalId: row.providerMediaId, filename: row.filename, ...(req.sizeBytes ?? row.sizeBytes ? { sizeBytes: req.sizeBytes ?? (row.sizeBytes as number) } : {}) });
  } catch (err) {
    const se = toSocialError(err);
    if (se.code === "PROVIDER_REJECTED") {
      await ctx.db.update(socialMedia).set({ status: "failed", error: "Provider did not confirm the upload", updatedAt: ctx.now() }).where(eq(socialMedia.id, row.id));
      throw new SocialError("MEDIA_INVALID", "The provider did not accept the uploaded file", { details: se.details ?? {} });
    }
    throw se;
  }
  const [updated] = await ctx.db
    .update(socialMedia)
    .set({ status: "ready", providerUrl: pm.url, providerExpiresAt: pm.expiresAt ?? null, sizeBytes: pm.sizeBytes ?? req.sizeBytes ?? row.sizeBytes, uploadExpiresAt: null, updatedAt: ctx.now() })
    .where(and(eq(socialMedia.id, row.id), eq(socialMedia.workspaceId, actor.workspace.id)))
    .returning();
  return toMedia(updated ?? row, actor.workspace);
}

async function loadMedia(db: Executor, ws: Workspace, id: string): Promise<SocialMediaRow> {
  assertUuid(id, "MEDIA_NOT_FOUND");
  const rows = await db.select().from(socialMedia).where(and(eq(socialMedia.id, id), eq(socialMedia.workspaceId, ws.id))).limit(1);
  if (!rows[0]) throw new SocialError("MEDIA_NOT_FOUND", "Media not found");
  return rows[0];
}

export async function getMedia(ctx: ServiceContext, actor: Actor, id: string): Promise<SocialMedia> {
  return toMedia(await loadMedia(ctx.db, actor.workspace, id), actor.workspace);
}

/** Load media rows for a workspace; any id not owned by the workspace is reported as not found. */
export async function loadWorkspaceMedia(db: Executor, workspaceId: string, ids: string[]): Promise<Map<string, SocialMediaRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(socialMedia).where(and(inArray(socialMedia.id, ids), eq(socialMedia.workspaceId, workspaceId)));
  const map = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((i) => !map.has(i));
  if (missing.length) throw new SocialError("MEDIA_NOT_FOUND", "Media not found", { details: { mediaIds: missing } });
  return map;
}

/**
 * Resolve media for dispatch. Media whose provider copy expires before the
 * publish time (plus a safety margin) is re-uploaded from its durable source
 * URL; direct uploads cannot be refreshed and fail with MEDIA_INVALID.
 */
export async function resolveProviderMedia(ctx: ServiceContext, workspaceId: string, ids: string[], publishAt: Date): Promise<ProviderMedia[]> {
  const rows = await loadWorkspaceMedia(ctx.db, workspaceId, ids);
  const out: ProviderMedia[] = [];
  for (const id of ids) {
    const row = rows.get(id) as SocialMediaRow;
    if (row.status !== "ready" || !row.providerMediaId || !row.providerUrl) {
      throw new SocialError("MEDIA_INVALID", "Media is not ready", { details: { mediaId: id, status: row.status } });
    }
    const deadline = Math.max(publishAt.getTime(), ctx.now().getTime()) + EXPIRY_SAFETY_MS;
    if (row.providerExpiresAt && row.providerExpiresAt.getTime() < deadline) {
      if (!row.sourceUrl) {
        throw new SocialError("MEDIA_INVALID", "Uploaded media expires at the provider before the publish time; register it by URL instead", { details: { mediaId: id } });
      }
      const pm = await uploadFromSource(ctx, row);
      await ctx.db
        .update(socialMedia)
        .set({ providerMediaId: pm.externalId, providerUrl: pm.url, providerExpiresAt: pm.expiresAt ?? null, updatedAt: ctx.now() })
        .where(eq(socialMedia.id, row.id));
      out.push(pm);
      continue;
    }
    out.push({
      externalId: row.providerMediaId,
      url: row.providerUrl,
      filename: row.filename,
      contentType: row.contentType,
      ...(row.sizeBytes ? { sizeBytes: row.sizeBytes } : {}),
      ...(row.providerExpiresAt ? { expiresAt: row.providerExpiresAt } : {}),
    });
  }
  return out;
}
