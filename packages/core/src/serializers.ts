import type { CapabilityRouter } from "@zeptly-social/capability-registry";
import type {
  ConnectionStatus,
  ErrorCode,
  ProvisioningSession,
  PublicationStatus,
  SocialConnection,
  SocialConversation,
  SocialMedia,
  SocialMessage,
  SocialMetric,
  SocialNetwork,
  SocialPost,
  SocialPostTarget,
  SocialPublication,
} from "@zeptly-social/domain";
import type {
  ProvisioningSessionRow,
  SocialConnectionRow,
  SocialConversationRow,
  SocialMediaRow,
  SocialMessageRow,
  SocialMetricRow,
  SocialPostRow,
  SocialPostTargetRow,
  SocialPublicationRow,
  Workspace,
} from "@zeptly-social/database";

/**
 * Row → canonical public object. These functions are the ONLY way data leaves
 * the service: provider identifiers (provider_accounts.external_id,
 * provider_post_id, provider_media_id, idempotency keys, session tokens) are
 * never copied into canonical objects.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const opt = <K extends string, V>(key: K, v: V | null | undefined): Partial<Record<K, V>> =>
  v === null || v === undefined ? {} : ({ [key]: v } as Record<K, V>);

function err(code: string | null, message: string | null): { error: { code: ErrorCode; message: string } } | Record<string, never> {
  return code ? { error: { code: code as ErrorCode, message: message ?? "" } } : {};
}

export function toConnection(row: SocialConnectionRow, ws: Workspace, router: CapabilityRouter): SocialConnection {
  return {
    id: row.id,
    workspaceId: ws.externalId,
    network: row.network as SocialNetwork,
    status: row.status as ConnectionStatus,
    ...opt("statusReason", row.statusReason),
    ...opt("displayName", row.displayName),
    ...opt("username", row.username),
    ...opt("avatarUrl", row.avatarUrl),
    ...opt("accountType", row.accountType as "personal" | "organization" | null),
    capabilities: router.providerCapabilities(row.provider, row.network as SocialNetwork),
    provider: row.provider,
    ...opt("connectedAt", iso(row.connectedAt)),
    ...opt("lastCheckedAt", iso(row.lastCheckedAt)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProvisioning(row: ProvisioningSessionRow, ws: Workspace): ProvisioningSession {
  return {
    id: row.id,
    workspaceId: ws.externalId,
    network: row.network as SocialNetwork,
    strategy: row.strategy as ProvisioningSession["strategy"],
    status: row.status as ProvisioningSession["status"],
    ...(row.status === "initiated" ? opt("authorizationUrl", row.authorizationUrl) : {}),
    ...(row.status === "awaiting_selection" && row.options ? { options: row.options as unknown as ProvisioningSession["options"] } : {}),
    connectionIds: row.connectionIds,
    ...opt("reconnectConnectionId", row.reconnectConnectionId),
    ...(row.errorCode ? { error: { code: row.errorCode as ErrorCode, message: row.errorMessage ?? "" } } : {}),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
    ...(row.lastErrorCode ? { lastError: { code: row.lastErrorCode as ErrorCode, message: row.lastError ?? "" } } : {}),
    ...opt("lastReconciledAt", iso(row.lastReconciledAt)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toConversation(row: SocialConversationRow, ws: Workspace): SocialConversation {
  const p = row.participant;
  return {
    id: row.id,
    workspaceId: ws.externalId,
    connectionId: row.connectionId,
    network: row.network as SocialNetwork,
    kind: "direct_message",
    participant: { ...opt("displayName", p.displayName), ...opt("username", p.username), ...opt("avatarUrl", p.avatarUrl) },
    ...opt("lastMessageAt", iso(row.lastMessageAt)),
    ...opt("lastMessagePreview", row.lastMessagePreview),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMessage(row: SocialMessageRow): SocialMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction as SocialMessage["direction"],
    status: row.status as SocialMessage["status"],
    ...opt("text", row.text),
    attachments: row.attachments,
    ...opt("sentAt", iso(row.sentAt)),
    ...err(row.errorCode, row.errorMessage),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMetric(row: SocialMetricRow, ws: Workspace): SocialMetric {
  return {
    workspaceId: ws.externalId,
    ...opt("connectionId", row.connectionId),
    ...opt("postId", row.postId),
    ...opt("targetId", row.targetId),
    network: row.network as SocialNetwork,
    metric: row.metric,
    value: row.value,
    measuredAt: row.measuredAt.toISOString(),
    provider: row.provider,
    semantics: `${row.network}.${row.metric}`,
  };
}
