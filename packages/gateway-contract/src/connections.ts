import { z } from "zod";

/**
 * Gateway connections: Zeptly workspace → gateway connection → provider account.
 * A connection is provider-neutral; its `channel` names the kind of account the
 * provider connected (for social gateways: the network, e.g. "linkedin").
 */

const IsoDateTime = z.iso.datetime({ offset: true });

export const CONNECTION_STATUSES = ["pending", "connected", "degraded", "reauthorization_required", "disconnected"] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ConnectionStrategySchema = z.enum(["oauth_redirect", "credentials", "provider_managed"]);
export type ConnectionStrategy = z.infer<typeof ConnectionStrategySchema>;

export const GatewayConnectionSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.string(),
    channel: z.string(),
    status: ConnectionStatusSchema,
    statusReason: z.string().optional(),
    displayName: z.string().optional(),
    username: z.string().optional(),
    avatarUrl: z.string().optional(),
    accountType: z.enum(["personal", "organization"]).optional(),
    provider: z.string().describe("Provider behind this gateway (diagnostic only)"),
    connectedAt: IsoDateTime.optional(),
    lastCheckedAt: IsoDateTime.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "GatewayConnection" });
export type GatewayConnection = z.infer<typeof GatewayConnectionSchema>;

export const PROVISIONING_STATUSES = ["initiated", "awaiting_selection", "completed", "failed", "expired"] as const;
export const ProvisioningStatusSchema = z.enum(PROVISIONING_STATUSES);
export type ProvisioningStatus = z.infer<typeof ProvisioningStatusSchema>;

export const ProvisioningOptionSchema = z
  .object({
    id: z.string().describe("Opaque option identifier to echo back on finalize"),
    name: z.string(),
    username: z.string().optional(),
    type: z.enum(["personal", "organization"]).optional(),
    avatarUrl: z.string().optional(),
  })
  .meta({ id: "ProvisioningOption" });
export type ProvisioningOption = z.infer<typeof ProvisioningOptionSchema>;

export const ProvisioningSessionSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.string(),
    channel: z.string(),
    network: z.string().describe("Deprecated alias of `channel` (social gateways)"),
    strategy: ConnectionStrategySchema,
    status: ProvisioningStatusSchema,
    authorizationUrl: z.string().optional().describe("Present for oauth_redirect/provider_managed: send the end user's browser here."),
    options: z.array(ProvisioningOptionSchema).optional().describe("Accounts/pages the user may select (awaiting_selection)."),
    connectionIds: z.array(z.uuid()),
    reconnectConnectionId: z.uuid().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    expiresAt: IsoDateTime,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "ProvisioningSession" });
export type ProvisioningSession = z.infer<typeof ProvisioningSessionSchema>;

export const FinalizeProvisioningRequestSchema = z
  .object({ optionIds: z.array(z.string().min(1)).min(1).max(50) })
  .meta({ id: "FinalizeProvisioningRequest" });
export type FinalizeProvisioningRequest = z.infer<typeof FinalizeProvisioningRequestSchema>;

/* ------------------------------------------------------------------ */
/* Pagination (shared by capability contracts)                         */
/* ------------------------------------------------------------------ */

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export function page<T extends z.ZodTypeAny>(item: T, id: string) {
  return z
    .object({
      data: z.array(item),
      nextCursor: z.string().optional(),
    })
    .meta({ id });
}
