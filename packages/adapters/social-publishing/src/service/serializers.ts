import type { GatewayConnection } from "@zeptly-gateway/gateway-contract";
import type { SocialMediaRow, SocialPostRow, SocialPostTargetRow, SocialPublicationRow, Workspace } from "@zeptly-gateway/database";
import { opt } from "@zeptly-gateway/gateway-core";
import type { PublicationStatus, SocialConnection, SocialMedia, SocialNetwork, SocialPost, SocialPostTarget, SocialPublication } from "../contract/index.js";
import type { NetworkCatalog } from "./catalog.js";

/**
 * Row → Social Publishing Contract objects. Provider identifiers
 * (provider_post_id, provider_media_id, idempotency keys) are never copied out.
 */
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

function err(code: string | null, message: string | null): { error: { code: string; message: string } } | Record<string, never> {
  return code ? { error: { code, message: message ?? "" } } : {};
}

/** Social view of a gateway connection: the channel is a social network, plus its per-network features. */
export function toSocialConnection(c: GatewayConnection, catalog: NetworkCatalog): SocialConnection {
  return { ...c, network: c.channel as SocialNetwork, capabilities: catalog.features(c.channel) };
}

export function toMedia(row: SocialMediaRow, ws: Workspace, uploadUrl?: string): SocialMedia {
  return {
    id: row.id,
    workspaceId: ws.externalId,
    status: row.status as SocialMedia["status"],
    kind: row.kind as SocialMedia["kind"],
    filename: row.filename,
    contentType: row.contentType,
    ...opt("sizeBytes", row.sizeBytes),
    sourceType: row.sourceType as SocialMedia["sourceType"],
    ...opt("sourceUrl", row.sourceUrl),
    ...opt("assetRef", row.assetRef),
    ...(uploadUrl ? { uploadUrl, ...opt("uploadUrlExpiresAt", iso(row.uploadExpiresAt)) } : {}),
    ...opt("error", row.error),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTarget(row: SocialPostTargetRow): SocialPostTarget {
  return {
    id: row.id,
    connectionId: row.connectionId,
    network: row.network as SocialNetwork,
    status: row.status as SocialPostTarget["status"],
    ...opt("content", row.content),
    ...opt("options", row.options),
    ...opt("platformPostId", row.platformPostId),
    ...opt("platformPostUrl", row.platformPostUrl),
    ...opt("publishedAt", iso(row.publishedAt)),
    ...err(row.errorCode, row.errorMessage),
  };
}

export function toPost(row: SocialPostRow, targets: SocialPostTargetRow[], ws: Workspace): SocialPost {
  return {
    id: row.id,
    workspaceId: ws.externalId,
    content: row.content,
    status: row.status as SocialPost["status"],
    ...opt("scheduledAt", iso(row.scheduledAt)),
    ...opt("timezone", row.timezone),
    targets: [...targets].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(toTarget),
    ...opt("externalRef", row.externalRef),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPublication(row: SocialPublicationRow, targetIds: string[]): SocialPublication {
  return {
    id: row.id,
    postId: row.postId,
    provider: row.provider,
    network: row.network as SocialNetwork,
    mode: row.mode as SocialPublication["mode"],
    status: row.status as PublicationStatus,
    targetIds,
    publishAt: row.publishAt.toISOString(),
    ...opt("handedOffAt", iso(row.handedOffAt)),
    attemptCount: row.attempts,
    ...(row.lastErrorCode ? { lastError: { code: row.lastErrorCode, message: row.lastError ?? "" } } : {}),
    ...opt("lastReconciledAt", iso(row.lastReconciledAt)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
