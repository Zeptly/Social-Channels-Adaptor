import type { ConnectionStatus, ErrorCode, GatewayConnection, ProvisioningSession } from "@zeptly-gateway/gateway-contract";
import type { GatewayConnectionRow, ProvisioningSessionRow, Workspace } from "@zeptly-gateway/database";

/**
 * Row → canonical gateway objects. Provider identifiers (provider_accounts.
 * external_id, provider session tokens, state hashes) are never copied out.
 */
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
export const opt = <K extends string, V>(key: K, v: V | null | undefined): Partial<Record<K, V>> =>
  v === null || v === undefined ? {} : ({ [key]: v } as Record<K, V>);

export function toConnection(row: GatewayConnectionRow, ws: Workspace): GatewayConnection {
  return {
    id: row.id,
    workspaceId: ws.externalId,
    channel: row.network,
    status: row.status as ConnectionStatus,
    ...opt("statusReason", row.statusReason),
    ...opt("displayName", row.displayName),
    ...opt("username", row.username),
    ...opt("avatarUrl", row.avatarUrl),
    ...opt("accountType", row.accountType as "personal" | "organization" | null),
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
    channel: row.network,
    network: row.network,
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
