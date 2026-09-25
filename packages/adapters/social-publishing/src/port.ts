import type { SocialNetwork } from "./contract/networks.js";

/**
 * Social Publishing port — what a gateway's provider adapter must provide so
 * the Social Publishing service can implement Social Publishing Contract v1.
 * Expressed in provider-neutral terms: `externalId`s are opaque provider
 * references stored only in integration columns (provider_accounts,
 * social_publications.provider_post_id, social_media.provider_media_id).
 * Implementations throw `UpstreamError` (gateway-contract) on failure.
 */

export interface RemoteMedia {
  externalId: string;
  url: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
  expiresAt?: Date;
}

export interface PreparedUpload {
  externalId: string;
  uploadUrl: string;
  expiresAt: Date;
}

export interface PublishRequest {
  /** UUID persisted before the call; identical on every retry of the same logical create. */
  idempotencyKey: string;
  network: SocialNetwork;
  /** Provider account ids resolved through the workspace's connection mappings — never usernames. */
  accountExternalIds: string[];
  text: string;
  media: RemoteMedia[];
  /** Verified network options (keys from the network catalog). */
  options: Record<string, unknown>;
  /** Omit for immediate publication. Must lie inside the provider scheduling horizon. */
  scheduledAt?: Date;
}

/** In-place edit of a not-yet-published provider post (same accounts, same provider reference). */
export type UpdateRequest = Omit<PublishRequest, "idempotencyKey" | "accountExternalIds" | "scheduledAt"> & { scheduledAt: Date };

export type RemoteTargetStatus = "pending" | "published" | "failed" | "deleted" | "unknown";

export interface RemoteTargetState {
  accountExternalId: string;
  status: RemoteTargetStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  error?: string;
  publishedAt?: Date;
}

export interface RemotePostState {
  externalId: string;
  scheduledAt?: Date;
  publishedAt?: Date;
  targets: RemoteTargetState[];
}

export interface SocialPublishingPort {
  readonly provider: string;
  /** Provider-imposed scheduling horizon (ms from now); undefined = unlimited. */
  readonly schedulingHorizonMs: number | undefined;
  /** True when updatePost is available and enabled; otherwise edits use delete + recreate. */
  readonly supportsPostUpdate: boolean;

  prepareUpload(input: { filename: string; contentType: string }): Promise<PreparedUpload>;
  confirmUpload(input: { externalId: string; filename: string; sizeBytes?: number }): Promise<RemoteMedia>;
  uploadFromUrl(input: { sourceUrl: string; filename: string; contentType: string; maxBytes: number }): Promise<RemoteMedia>;

  publish(input: PublishRequest): Promise<RemotePostState>;
  schedule(input: PublishRequest & { scheduledAt: Date }): Promise<RemotePostState>;
  getPost(externalId: string): Promise<RemotePostState>;
  /** Idempotent: an already-deleted post resolves successfully. */
  deletePost(externalId: string): Promise<void>;
  updatePost?(externalId: string, input: UpdateRequest): Promise<RemotePostState>;
}

/** Normalized webhook event claimed by the Social Publishing capability. */
export const PUBLICATION_OUTCOME_EVENT = "social.publication_outcome" as const;

export interface PublicationOutcomeEvent {
  kind: typeof PUBLICATION_OUTCOME_EVENT;
  providerPostId: string;
  accounts: Array<{
    accountExternalId: string;
    outcome: "published" | "failed";
    platformPostId?: string;
    platformPostUrl?: string;
    error?: string;
  }>;
}
