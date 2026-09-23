import { z } from "zod";
import { SocialCapabilitiesSchema } from "./capabilities.js";
import { ConnectionStrategySchema, SocialNetworkSchema } from "./networks.js";
import { ErrorCodeSchema } from "./errors.js";

const IsoDateTime = z.iso.datetime({ offset: true });
const Id = z.uuid();

/* ------------------------------------------------------------------ */
/* Connections & provisioning                                          */
/* ------------------------------------------------------------------ */

export const CONNECTION_STATUSES = ["pending", "connected", "degraded", "reauthorization_required", "disconnected"] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const SocialConnectionSchema = z
  .object({
    id: Id,
    workspaceId: z.string().describe("Zeptly workspace identifier"),
    network: SocialNetworkSchema,
    status: ConnectionStatusSchema,
    statusReason: z.string().optional(),
    displayName: z.string().optional(),
    username: z.string().optional(),
    avatarUrl: z.string().optional(),
    accountType: z.enum(["personal", "organization"]).optional(),
    capabilities: SocialCapabilitiesSchema,
    provider: z.string().describe("Provider currently serving this connection (diagnostic only)"),
    connectedAt: IsoDateTime.optional(),
    lastCheckedAt: IsoDateTime.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "SocialConnection" });
export type SocialConnection = z.infer<typeof SocialConnectionSchema>;

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
    id: Id,
    workspaceId: z.string(),
    network: SocialNetworkSchema,
    strategy: ConnectionStrategySchema,
    status: ProvisioningStatusSchema,
    authorizationUrl: z.string().optional().describe("Present for oauth_redirect: send the end user's browser here."),
    options: z.array(ProvisioningOptionSchema).optional().describe("Accounts/pages the user may select (awaiting_selection)."),
    connectionIds: z.array(Id),
    reconnectConnectionId: Id.optional(),
    error: z.object({ code: ErrorCodeSchema, message: z.string() }).optional(),
    expiresAt: IsoDateTime,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "ProvisioningSession" });
export type ProvisioningSession = z.infer<typeof ProvisioningSessionSchema>;

export const CreateConnectionRequestSchema = z
  .object({
    network: SocialNetworkSchema,
    returnUrl: z
      .url()
      .optional()
      .describe("Zeptly URL the end user returns to after provider authorization (oauth_redirect networks). Must match ALLOWED_RETURN_URL_ORIGINS."),
    credentials: z
      .object({
        handle: z.string().min(3).max(253),
        appPassword: z.string().min(8).max(128),
      })
      .optional()
      .describe("Required for credentials strategy (Bluesky). Forwarded to the provider once and never persisted."),
  })
  .meta({ id: "CreateConnectionRequest" });
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequestSchema>;

export const ReconnectRequestSchema = z
  .object({
    returnUrl: z.url().optional(),
    credentials: CreateConnectionRequestSchema.shape.credentials,
  })
  .meta({ id: "ReconnectRequest" });
export type ReconnectRequest = z.infer<typeof ReconnectRequestSchema>;

export const FinalizeProvisioningRequestSchema = z
  .object({
    optionIds: z.array(z.string().min(1)).min(1).max(50),
  })
  .meta({ id: "FinalizeProvisioningRequest" });
export type FinalizeProvisioningRequest = z.infer<typeof FinalizeProvisioningRequestSchema>;

export const CreateConnectionResponseSchema = z
  .object({
    provisioning: ProvisioningSessionSchema,
    connections: z.array(SocialConnectionSchema),
  })
  .meta({ id: "CreateConnectionResponse" });

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

export const MEDIA_STATUSES = ["pending_upload", "processing", "ready", "failed"] as const;
export const MediaStatusSchema = z.enum(MEDIA_STATUSES);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;

export const MediaSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("url"),
    url: z.url().describe("Durable, publicly fetchable HTTPS object-storage URL"),
  }),
  z.object({
    type: z.literal("asset"),
    assetRef: z.string().min(1).max(256).describe("Zeptly asset identifier (stored for traceability)"),
    url: z.url().describe("Durable HTTPS URL at which the asset can be fetched"),
  }),
  z.object({
    type: z.literal("upload").describe("Direct upload: the response carries a short-lived uploadUrl to PUT the bytes to."),
  }),
]);
export type MediaSource = z.infer<typeof MediaSourceSchema>;

export const RegisterMediaRequestSchema = z
  .object({
    source: MediaSourceSchema,
    filename: z.string().min(1).max(255),
    contentType: z.string().min(3).max(100),
    sizeBytes: z.number().int().positive().optional(),
  })
  .meta({ id: "RegisterMediaRequest" });
export type RegisterMediaRequest = z.infer<typeof RegisterMediaRequestSchema>;

export const SocialMediaSchema = z
  .object({
    id: Id,
    workspaceId: z.string(),
    status: MediaStatusSchema,
    kind: z.enum(["image", "video"]),
    filename: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int().optional(),
    sourceType: z.enum(["url", "asset", "upload"]),
    sourceUrl: z.string().optional(),
    assetRef: z.string().optional(),
    uploadUrl: z.string().optional().describe("Only returned for pending direct uploads"),
    uploadUrlExpiresAt: IsoDateTime.optional(),
    error: z.string().optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "SocialMedia" });
export type SocialMedia = z.infer<typeof SocialMediaSchema>;

export const CompleteMediaUploadRequestSchema = z
  .object({ sizeBytes: z.number().int().positive().optional() })
  .meta({ id: "CompleteMediaUploadRequest" });

/* ------------------------------------------------------------------ */
/* Posts                                                               */
/* ------------------------------------------------------------------ */

export const SocialContentSchema = z
  .object({
    text: z.string().max(70_000).optional(),
    mediaIds: z.array(Id).max(20).optional().describe("Canonical media ids registered via /v1/media"),
  })
  .meta({ id: "SocialContent" });
export type SocialContent = z.infer<typeof SocialContentSchema>;

export const POST_STATUSES = [
  "draft",
  "queued",
  "scheduled",
  "publishing",
  "partially_published",
  "published",
  "failed",
  "cancelled",
] as const;
export const PostStatusSchema = z.enum(POST_STATUSES);
export type PostStatus = z.infer<typeof PostStatusSchema>;

export const TARGET_STATUSES = ["pending", "scheduled", "publishing", "published", "failed", "cancelled"] as const;
export const TargetStatusSchema = z.enum(TARGET_STATUSES);
export type TargetStatus = z.infer<typeof TargetStatusSchema>;

export const NetworkOptionsSchema = z
  .record(z.string(), z.unknown())
  .describe("Verified network-specific configuration; allowed keys per network are published in /v1/networks constraints.");

export const SocialPostTargetInputSchema = z
  .object({
    connectionId: Id,
    content: SocialContentSchema.optional().describe("Per-target override of the base content (already-generated variant)"),
    options: NetworkOptionsSchema.optional(),
  })
  .meta({ id: "PostTargetRequest" });
export type SocialPostTargetInput = z.infer<typeof SocialPostTargetInputSchema>;

export const SocialPostTargetSchema = z
  .object({
    id: Id,
    connectionId: Id,
    network: SocialNetworkSchema,
    status: TargetStatusSchema,
    content: SocialContentSchema.optional(),
    options: NetworkOptionsSchema.optional(),
    platformPostId: z.string().optional(),
    platformPostUrl: z.string().optional(),
    publishedAt: IsoDateTime.optional(),
    error: z.object({ code: ErrorCodeSchema, message: z.string() }).optional(),
  })
  .meta({ id: "SocialPostTarget" });
export type SocialPostTarget = z.infer<typeof SocialPostTargetSchema>;

export const SocialPostSchema = z
  .object({
    id: Id,
    workspaceId: z.string(),
    content: SocialContentSchema,
    status: PostStatusSchema,
    scheduledAt: IsoDateTime.optional(),
    timezone: z.string().optional(),
    targets: z.array(SocialPostTargetSchema),
    externalRef: z.string().optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "SocialPost" });
export type SocialPost = z.infer<typeof SocialPostSchema>;

export const CreatePostRequestSchema = z
  .object({
    content: SocialContentSchema,
    targets: z.array(SocialPostTargetInputSchema).min(1).max(25),
    externalRef: z.string().max(256).optional().describe("Zeptly-side reference (e.g. content item id) for traceability"),
  })
  .meta({ id: "CreatePostRequest" });
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

export const UpdatePostRequestSchema = z
  .object({
    content: SocialContentSchema.optional(),
    targets: z.array(SocialPostTargetInputSchema).min(1).max(25).optional().describe("Full replacement of the target list (variants/options included)"),
    externalRef: z.string().max(256).optional(),
  })
  .refine((v) => v.content !== undefined || v.targets !== undefined || v.externalRef !== undefined, { message: "Nothing to update" })
  .meta({ id: "UpdatePostRequest" });
export type UpdatePostRequest = z.infer<typeof UpdatePostRequestSchema>;

export const SchedulePostRequestSchema = z
  .object({
    scheduledAt: IsoDateTime.describe("Execution instant; any offset accepted, stored as UTC"),
    timezone: z.string().max(64).optional().describe("IANA timezone of the original intent (metadata only)"),
  })
  .meta({ id: "SchedulePostRequest" });
export type SchedulePostRequest = z.infer<typeof SchedulePostRequestSchema>;

/**
 * Publication = one provider submission for a group of targets that share
 * network, content and options. It doubles as the durable dispatch queue entry.
 */
export const PUBLICATION_STATUSES = [
  "pending",
  "dispatching",
  "retry_pending",
  "accepted",
  "published",
  "partially_published",
  "failed",
  "cancelled",
] as const;
export const PublicationStatusSchema = z.enum(PUBLICATION_STATUSES);
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;

export const SocialPublicationSchema = z
  .object({
    id: Id,
    postId: Id,
    provider: z.string(),
    network: SocialNetworkSchema,
    mode: z.enum(["immediate", "scheduled"]),
    status: PublicationStatusSchema,
    targetIds: z.array(Id),
    publishAt: IsoDateTime,
    handedOffAt: IsoDateTime.optional(),
    attemptCount: z.number().int(),
    lastError: z.object({ code: ErrorCodeSchema, message: z.string() }).optional(),
    lastReconciledAt: IsoDateTime.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "SocialPublication", description: "One provider submission covering one or more targets." });
export type SocialPublication = z.infer<typeof SocialPublicationSchema>;

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export const SocialParticipantSchema = z
  .object({
    displayName: z.string().optional(),
    username: z.string().optional(),
    avatarUrl: z.string().optional(),
  })
  .meta({ id: "SocialParticipant" });

export const SocialConversationSchema = z
  .object({
    id: Id,
    workspaceId: z.string(),
    connectionId: Id,
    network: SocialNetworkSchema,
    kind: z.enum(["direct_message"]),
    participant: SocialParticipantSchema,
    lastMessageAt: IsoDateTime.optional(),
    lastMessagePreview: z.string().optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "SocialConversation" });
export type SocialConversation = z.infer<typeof SocialConversationSchema>;

export const SocialMessageSchema = z
  .object({
    id: Id,
    conversationId: Id,
    direction: z.enum(["inbound", "outbound"]),
    status: z.enum(["received", "sending", "sent", "failed"]),
    text: z.string().optional(),
    attachments: z.array(z.object({ type: z.string(), url: z.string().optional() })),
    sentAt: IsoDateTime.optional(),
    error: z.object({ code: ErrorCodeSchema, message: z.string() }).optional(),
    createdAt: IsoDateTime,
  })
  .meta({ id: "SocialMessage" });
export type SocialMessage = z.infer<typeof SocialMessageSchema>;

export const SendMessageRequestSchema = z
  .object({ text: z.string().min(1).max(1000) })
  .meta({ id: "SendMessageRequest" });
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

export const SocialMetricSchema = z
  .object({
    workspaceId: z.string(),
    connectionId: Id.optional(),
    postId: Id.optional(),
    targetId: Id.optional(),
    network: SocialNetworkSchema,
    metric: z.string().describe("Provider-reported metric name, namespaced by network semantics — not cross-network comparable"),
    value: z.number(),
    measuredAt: IsoDateTime,
    provider: z.string(),
    semantics: z
      .string()
      .describe("`<network>.<metric>` key. Metrics with different semantics keys must not be treated as equivalent."),
  })
  .meta({ id: "SocialMetric" });
export type SocialMetric = z.infer<typeof SocialMetricSchema>;

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
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
