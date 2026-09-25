import { GatewayConnectionSchema } from "@zeptly-gateway/gateway-contract";
import { z } from "zod";
import { SocialCapabilitiesSchema } from "./capabilities.js";
import { SocialNetworkSchema } from "./networks.js";

/**
 * Social Publishing Contract v1 — canonical domain. Provider-neutral: no
 * provider identifiers, wire objects or provider semantics appear here, so any
 * gateway (Outstand today) can implement it without changing this domain.
 */

const IsoDateTime = z.iso.datetime({ offset: true });
const Id = z.uuid();
const ErrorRef = z.object({ code: z.string(), message: z.string() });

/* ------------------------------------------------------------------ */
/* Connections (social view of a gateway connection)                    */
/* ------------------------------------------------------------------ */

export const SocialConnectionSchema = GatewayConnectionSchema.extend({
  network: SocialNetworkSchema.describe("Social network of this connection (equals `channel`)"),
  capabilities: SocialCapabilitiesSchema,
}).meta({ id: "SocialConnection" });
export type SocialConnection = z.infer<typeof SocialConnectionSchema>;

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
    mediaIds: z.array(Id).max(20).optional().describe("Canonical media ids registered via POST /v1/social/publishing/media"),
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
    error: ErrorRef.optional(),
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
export const SocialScheduleSchema = z
  .object({
    postId: Id,
    scheduledAt: IsoDateTime.describe("Canonical execution instant (UTC)"),
    timezone: z.string().optional(),
    status: z.enum(["active", "completed", "cancelled"]),
    revision: z.number().int(),
  })
  .meta({ id: "SocialSchedule", description: "The gateway-owned canonical schedule; providers only ever see hand-offs inside their horizon." });
export type SocialSchedule = z.infer<typeof SocialScheduleSchema>;

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
    lastError: ErrorRef.optional(),
    lastReconciledAt: IsoDateTime.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "SocialPublication", description: "One provider submission covering one or more targets." });
export type SocialPublication = z.infer<typeof SocialPublicationSchema>;
