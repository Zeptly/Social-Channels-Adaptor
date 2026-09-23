import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Tenant model: every tenant-owned row carries `workspace_id` (FK to
 * workspaces.id). Composite foreign keys are not used; instead every query in
 * the core services filters on workspace_id and every child lookup is
 * re-validated against the parent's workspace (see packages/core/src/tenancy.ts).
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

/** External Zeptly workspace identity + isolation metadata only. */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: text("external_id").notNull().unique(),
  /** Opaque random tenant reference sent to providers (never the Zeptly id). */
  providerTenantRef: text("provider_tenant_ref").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const provisioningSessions = pgTable(
  "provisioning_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    network: text("network").notNull(),
    provider: text("provider").notNull(),
    strategy: text("strategy").notNull(),
    status: text("status").notNull(),
    /** SHA-256 of the state token embedded in the provider redirect URI. */
    stateHash: text("state_hash").unique(),
    returnUrl: text("return_url"),
    authorizationUrl: text("authorization_url"),
    /** Provider pending-session handle (short-lived); cleared on completion/expiry. */
    providerSessionToken: text("provider_session_token"),
    options: jsonb("options").$type<Array<Record<string, unknown>>>(),
    reconnectConnectionId: uuid("reconnect_connection_id"),
    connectionIds: jsonb("connection_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: text("created_by"),
    expiresAt: ts("expires_at").notNull(),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("provisioning_sessions_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const socialConnections = pgTable(
  "social_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    network: text("network").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    statusReason: text("status_reason"),
    displayName: text("display_name"),
    username: text("username"),
    avatarUrl: text("avatar_url"),
    accountType: text("account_type"),
    connectedAt: ts("connected_at"),
    lastCheckedAt: ts("last_checked_at"),
    disconnectedAt: ts("disconnected_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("social_connections_workspace_idx").on(t.workspaceId, t.status)],
);

/**
 * Explicit workspace → connection → provider account mapping. A provider
 * account can belong to exactly one workspace (UNIQUE(provider, external_id)),
 * so a second workspace can never adopt it.
 */
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().unique().references(() => socialConnections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    network: text("network").notNull(),
    tenantRef: text("tenant_ref"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("provider_accounts_provider_external_uq").on(t.provider, t.externalId), index("provider_accounts_workspace_idx").on(t.workspaceId)],
);

export const socialMedia = pgTable(
  "social_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    kind: text("kind").notNull(),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url"),
    assetRef: text("asset_ref"),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    provider: text("provider").notNull(),
    providerMediaId: text("provider_media_id"),
    providerUrl: text("provider_url"),
    providerExpiresAt: ts("provider_expires_at"),
    uploadExpiresAt: ts("upload_expires_at"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("social_media_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const socialPosts = pgTable(
  "social_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    content: jsonb("content").$type<{ text?: string; mediaIds?: string[] }>().notNull(),
    externalRef: text("external_ref"),
    scheduledAt: ts("scheduled_at"),
    timezone: text("timezone"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdBy: text("created_by"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("social_posts_workspace_idem_uq").on(t.workspaceId, t.idempotencyKey), index("social_posts_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const socialPublications = pgTable(
  "social_publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    postId: uuid("post_id").notNull().references(() => socialPosts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    network: text("network").notNull(),
    /** Frozen per-group payload: text, media ids, options. */
    snapshot: jsonb("snapshot").$type<{ text: string; mediaIds: string[]; options: Record<string, unknown> }>().notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    publishAt: ts("publish_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: ts("next_attempt_at"),
    idempotencyKey: uuid("idempotency_key"),
    idempotencyKeyCreatedAt: ts("idempotency_key_created_at"),
    lockedBy: text("locked_by"),
    lockedAt: ts("locked_at"),
    providerPostId: text("provider_post_id"),
    handedOffAt: ts("handed_off_at"),
    lastReconciledAt: ts("last_reconciled_at"),
    metricsFetchedAt: ts("metrics_fetched_at"),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("social_publications_provider_post_uq").on(t.provider, t.providerPostId),
    index("social_publications_queue_idx").on(t.status, t.publishAt),
    index("social_publications_post_idx").on(t.postId),
  ],
);

export const socialPostTargets = pgTable(
  "social_post_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    postId: uuid("post_id").notNull().references(() => socialPosts.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => socialConnections.id),
    publicationId: uuid("publication_id").references(() => socialPublications.id, { onDelete: "set null" }),
    network: text("network").notNull(),
    content: jsonb("content").$type<{ text?: string; mediaIds?: string[] }>(),
    options: jsonb("options").$type<Record<string, unknown>>(),
    status: text("status").notNull(),
    platformPostId: text("platform_post_id"),
    platformPostUrl: text("platform_post_url"),
    publishedAt: ts("published_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("social_post_targets_post_connection_uq").on(t.postId, t.connectionId),
    index("social_post_targets_publication_idx").on(t.publicationId),
  ],
);

/** Canonical long-range schedule (system of record); providers only see handed-off windows. */
export const socialSchedules = pgTable(
  "social_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    postId: uuid("post_id").notNull().unique().references(() => socialPosts.id, { onDelete: "cascade" }),
    scheduledAt: ts("scheduled_at").notNull(),
    timezone: text("timezone"),
    status: text("status").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("social_schedules_due_idx").on(t.status, t.scheduledAt)],
);

export const socialConversations = pgTable(
  "social_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => socialConnections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    network: text("network").notNull(),
    kind: text("kind").notNull().default("direct_message"),
    participant: jsonb("participant").$type<{ displayName?: string; username?: string; avatarUrl?: string; externalId?: string }>().notNull(),
    lastMessageAt: ts("last_message_at"),
    lastMessagePreview: text("last_message_preview"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("social_conversations_provider_external_uq").on(t.provider, t.externalId),
    index("social_conversations_workspace_idx").on(t.workspaceId, t.lastMessageAt),
  ],
);

export const socialMessages = pgTable(
  "social_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => socialConversations.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    direction: text("direction").notNull(),
    status: text("status").notNull(),
    text: text("text"),
    attachments: jsonb("attachments").$type<Array<{ type: string; url?: string }>>().notNull().default(sql`'[]'::jsonb`),
    idempotencyKey: text("idempotency_key"),
    sentAt: ts("sent_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("social_messages_conversation_external_uq").on(t.conversationId, t.externalId),
    uniqueIndex("social_messages_conversation_idem_uq").on(t.conversationId, t.idempotencyKey),
    index("social_messages_conversation_idx").on(t.conversationId, t.createdAt),
  ],
);

export const socialMetrics = pgTable(
  "social_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => socialConnections.id, { onDelete: "set null" }),
    postId: uuid("post_id").references(() => socialPosts.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").references(() => socialPostTargets.id, { onDelete: "cascade" }),
    network: text("network").notNull(),
    metric: text("metric").notNull(),
    value: doublePrecision("value").notNull(),
    provider: text("provider").notNull(),
    measuredAt: ts("measured_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("social_metrics_snapshot_uq").on(t.targetId, t.metric, t.measuredAt),
    index("social_metrics_workspace_idx").on(t.workspaceId, t.postId, t.measuredAt),
  ],
);

/** Normalized provider-side state changes (from webhooks or reconciliation). */
export const providerEvents = pgTable(
  "provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    source: text("source").notNull(),
    type: text("type").notNull(),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("provider_events_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    /** Redacted payload for diagnostics. */
    payload: jsonb("payload").$type<unknown>(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("webhook_events_provider_event_uq").on(t.provider, t.providerEventId),
    index("webhook_events_status_idx").on(t.status, t.receivedAt),
  ],
);

/** PostgreSQL-backed durable job queue. */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedAt: ts("locked_at"),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key"),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_active_dedupe_uq").on(t.dedupeKey).where(sql`${t.status} in ('pending', 'running') and ${t.dedupeKey} is not null`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    actorService: text("actor_service"),
    actorAgent: text("actor_agent"),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    requestId: text("request_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_workspace_idx").on(t.workspaceId, t.createdAt), index("audit_events_resource_idx").on(t.resourceType, t.resourceId)],
);

/** API-level idempotency for mutating Zeptly requests (publish, schedule, cancel, send message). */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [uniqueIndex("idempotency_keys_workspace_key_uq").on(t.workspaceId, t.operation, t.key)],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: ts("started_at").notNull(),
  lastBeatAt: ts("last_beat_at").notNull(),
  version: text("version"),
});

export type Workspace = typeof workspaces.$inferSelect;
export type ProvisioningSessionRow = typeof provisioningSessions.$inferSelect;
export type SocialConnectionRow = typeof socialConnections.$inferSelect;
export type ProviderAccountRow = typeof providerAccounts.$inferSelect;
export type SocialMediaRow = typeof socialMedia.$inferSelect;
export type SocialPostRow = typeof socialPosts.$inferSelect;
export type SocialPostTargetRow = typeof socialPostTargets.$inferSelect;
export type SocialPublicationRow = typeof socialPublications.$inferSelect;
export type SocialScheduleRow = typeof socialSchedules.$inferSelect;
export type SocialConversationRow = typeof socialConversations.$inferSelect;
export type SocialMessageRow = typeof socialMessages.$inferSelect;
export type SocialMetricRow = typeof socialMetrics.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
