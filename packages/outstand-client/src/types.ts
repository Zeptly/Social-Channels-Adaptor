/**
 * Typed, sanitized results of the Outstand client. These are NOT Outstand wire
 * objects (those stay private to wire.ts): token-bearing fields are dropped,
 * envelopes are unwrapped and snake/camel variations are normalized. They still
 * carry Outstand identifiers (`externalId`) and must only be consumed by the
 * Outstand gateway's own adapters, never by canonical capability domains.
 */

export interface OutstandAccount {
  externalId: string;
  network: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  accountType?: "personal" | "organization";
  isActive: boolean;
  /** Opaque tenant correlation value recorded by Outstand, when available. */
  tenantRef?: string;
}

export interface OutstandPendingOption {
  id: string;
  name: string;
  username?: string;
  type?: "personal" | "organization";
  avatarUrl?: string;
}

export interface OutstandPendingConnection {
  network: string;
  expiresAt?: Date;
  options: OutstandPendingOption[];
}

export interface OutstandMedia {
  externalId: string;
  url: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
  expiresAt?: Date;
}

export interface OutstandPreparedUpload {
  externalId: string;
  uploadUrl: string;
  expiresAt: Date;
}

export interface OutstandCreatePostInput {
  /** UUID persisted before the call; identical on every retry of the same logical create. */
  idempotencyKey: string;
  network: string;
  /** Outstand account ids — never usernames. */
  accountExternalIds: string[];
  text: string;
  media: OutstandMedia[];
  /** Network option block values (only evidenced keys are sent). */
  options: Record<string, unknown>;
  /** Omit for immediate publication. Must lie inside the Outstand scheduling horizon. */
  scheduledAt?: Date;
}

export type OutstandUpdatePostInput = Omit<OutstandCreatePostInput, "idempotencyKey" | "accountExternalIds" | "scheduledAt"> & { scheduledAt: Date };

export type OutstandTargetStatus = "pending" | "published" | "failed" | "deleted" | "unknown";

export interface OutstandTargetState {
  accountExternalId: string;
  status: OutstandTargetStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  error?: string;
  publishedAt?: Date;
}

export interface OutstandPostState {
  externalId: string;
  scheduledAt?: Date;
  publishedAt?: Date;
  targets: OutstandTargetState[];
}

export interface OutstandMetricValue {
  name: string;
  value: number;
}

export interface OutstandPostMetrics {
  accountExternalId: string;
  network?: string;
  platformPostId?: string;
  metrics: OutstandMetricValue[];
}

export interface OutstandParticipant {
  externalId?: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
}

export interface OutstandMessage {
  externalId: string;
  conversationExternalId: string;
  direction: "inbound" | "outbound";
  status: "received" | "sent" | "failed" | "sending";
  text?: string;
  attachments: Array<{ type: string; url?: string }>;
  sentAt?: Date;
  error?: string;
}

export interface OutstandConversation {
  externalId: string;
  accountExternalId: string;
  participant: OutstandParticipant;
  lastMessageAt?: Date;
  lastMessagePreview?: string;
}

export interface OutstandPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface OutstandPostOutcomeAccount {
  accountExternalId: string;
  outcome: "published" | "failed";
  platformPostId?: string;
  platformPostUrl?: string;
  error?: string;
}

/** An authenticated Outstand webhook, interpreted into typed facts. */
export type OutstandWebhookEvent =
  | { kind: "post_outcome"; providerPostId: string; accounts: OutstandPostOutcomeAccount[]; occurredAt: Date }
  | { kind: "account_token_expired"; accountExternalId: string; reason?: string; occurredAt: Date }
  | { kind: "conversation_message"; accountExternalId: string; conversation: OutstandConversation; message?: OutstandMessage; occurredAt: Date }
  | { kind: "test"; occurredAt: Date }
  | { kind: "ignored"; occurredAt: Date };

export interface ParsedOutstandWebhook {
  /** Outstand event type string, e.g. "post.published". */
  type: string;
  /** Deterministic identity: redeliveries of the same logical event share it. */
  eventId: string;
  event: OutstandWebhookEvent;
}
