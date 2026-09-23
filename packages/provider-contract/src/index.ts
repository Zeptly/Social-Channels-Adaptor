import type { ProviderName, SocialNetwork } from "@zeptly-social/domain";

/**
 * Provider contract (spec §25). Everything here is expressed in provider-neutral
 * terms: `externalId`s are opaque provider identifiers that live only in
 * integration records (provider_accounts, social_publications, ...) and never
 * appear in the public Social API.
 */

export interface ProviderAccount {
  externalId: string;
  network: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  accountType?: "personal" | "organization";
  isActive: boolean;
  /** Opaque tenant correlation value the provider recorded for this account, when available. */
  tenantRef?: string;
}

export interface InitiateConnectionInput {
  network: SocialNetwork;
  /** Where the provider sends the end user's browser after authorization. */
  redirectUri: string;
  /** Opaque, per-workspace tenant correlation reference (never a Zeptly id). */
  tenantRef: string;
}

export interface CredentialsConnectionInput {
  network: SocialNetwork;
  tenantRef: string;
  credentials: { handle: string; appPassword: string };
}

export interface PendingConnectionOption {
  id: string;
  name: string;
  username?: string;
  type?: "personal" | "organization";
  avatarUrl?: string;
}

export interface PendingConnection {
  network: string;
  expiresAt?: Date;
  options: PendingConnectionOption[];
}

export interface ProviderMedia {
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

export interface ProviderPublishRequest {
  /** UUID persisted before the call; identical on every retry of the same logical create. */
  idempotencyKey: string;
  network: SocialNetwork;
  /** Provider account ids — never usernames. */
  accountExternalIds: string[];
  text: string;
  media: ProviderMedia[];
  /** Verified network options (keys from the capability registry). */
  options: Record<string, unknown>;
  /** Omit for immediate publication. Must lie inside the provider scheduling horizon. */
  scheduledAt?: Date;
}

export type ProviderTargetStatus = "pending" | "published" | "failed" | "deleted" | "unknown";

export interface ProviderTargetState {
  accountExternalId: string;
  status: ProviderTargetStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  error?: string;
  publishedAt?: Date;
}

export interface ProviderPostState {
  externalId: string;
  scheduledAt?: Date;
  publishedAt?: Date;
  targets: ProviderTargetState[];
}

export interface ProviderMetricValue {
  /** Provider-native metric name (e.g. "likes", or a platform_specific key). */
  name: string;
  value: number;
}

export interface ProviderPostMetrics {
  accountExternalId: string;
  network?: string;
  platformPostId?: string;
  metrics: ProviderMetricValue[];
}

export interface ProviderParticipant {
  externalId?: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
}

export interface ProviderMessage {
  externalId: string;
  conversationExternalId: string;
  direction: "inbound" | "outbound";
  status: "received" | "sent" | "failed" | "sending";
  text?: string;
  attachments: Array<{ type: string; url?: string }>;
  sentAt?: Date;
  error?: string;
}

export interface ProviderConversation {
  externalId: string;
  accountExternalId: string;
  participant: ProviderParticipant;
  lastMessageAt?: Date;
  lastMessagePreview?: string;
}

export interface ProviderPage<T> {
  items: T[];
  nextCursor?: string;
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

export type SignatureCheck = "valid" | "invalid" | "missing";

export interface PostOutcomeAccount {
  accountExternalId: string;
  outcome: "published" | "failed";
  platformPostId?: string;
  platformPostUrl?: string;
  error?: string;
}

/** Provider webhook normalized into provider-neutral facts. Ownership is NEVER derived from these. */
export type ProviderEvent =
  | { kind: "post_outcome"; providerPostId: string; accounts: PostOutcomeAccount[]; occurredAt: Date }
  | { kind: "account_reauthorization_required"; accountExternalId: string; reason?: string; occurredAt: Date }
  | {
      kind: "conversation_message";
      accountExternalId: string;
      conversation: ProviderConversation;
      message?: ProviderMessage;
      occurredAt: Date;
    }
  | { kind: "test"; occurredAt: Date }
  | { kind: "ignored"; occurredAt: Date };

export interface ParsedWebhook {
  /** Provider event type string, e.g. "post.published". */
  type: string;
  /** Deterministic identity: redeliveries of the same logical event share it. */
  eventId: string;
  event: ProviderEvent;
}

export interface WebhookVerifier {
  readonly signatureHeader: string;
  verify(rawBody: Buffer, signatureHeader: string | undefined): SignatureCheck;
  /** Throws ProviderError("protocol") on malformed payloads. */
  parse(rawBody: Buffer): ParsedWebhook;
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export interface SocialProvider {
  readonly name: ProviderName;
  /** Provider-imposed scheduling horizon (ms from now); undefined = unlimited. */
  readonly schedulingHorizonMs: number | undefined;
  readonly webhooks: WebhookVerifier;

  /** Cheap credential/reachability probe (not used by /ready to avoid provider traffic). */
  checkCredentials(): Promise<{ ok: boolean; message: string }>;

  initiateConnection(input: InitiateConnectionInput): Promise<{ authorizationUrl: string }>;
  connectWithCredentials?(input: CredentialsConnectionInput): Promise<ProviderAccount[]>;
  getPendingConnection(sessionToken: string): Promise<PendingConnection>;
  finalizeConnection(sessionToken: string, optionIds: string[]): Promise<ProviderAccount[]>;
  listAccounts(filter?: { tenantRef?: string }): Promise<ProviderAccount[]>;
  disconnectAccount(accountExternalId: string): Promise<void>;

  prepareUpload(input: { filename: string; contentType: string }): Promise<PreparedUpload>;
  confirmUpload(input: { externalId: string; filename: string; sizeBytes?: number }): Promise<ProviderMedia>;
  uploadFromUrl(input: { sourceUrl: string; filename: string; contentType: string; maxBytes: number }): Promise<ProviderMedia>;

  publish(input: ProviderPublishRequest): Promise<ProviderPostState>;
  schedule(input: ProviderPublishRequest & { scheduledAt: Date }): Promise<ProviderPostState>;
  getPost(externalId: string): Promise<ProviderPostState>;
  /** Idempotent: an already-deleted post resolves successfully. */
  deletePost(externalId: string): Promise<void>;

  getMetrics?(postExternalId: string): Promise<ProviderPostMetrics[]>;

  listConversations?(input: { accountExternalId: string; cursor?: string }): Promise<ProviderPage<ProviderConversation>>;
  listMessages?(input: { conversationExternalId: string; cursor?: string }): Promise<ProviderPage<ProviderMessage>>;
  sendMessage?(input: { conversationExternalId: string; text: string; idempotencyKey: string }): Promise<ProviderMessage>;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ProviderErrorKind =
  | "auth"
  | "validation"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "protocol"
  | "unsupported";

export interface ProviderErrorOptions {
  status?: number;
  retryable: boolean;
  /** The remote side may have applied a mutating request (timeout/5xx after send). */
  ambiguous: boolean;
  retryAfterSeconds?: number;
  /** Sanitized diagnostics only — never tokens or keys. */
  details?: Record<string, unknown>;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(provider: string, kind: ProviderErrorKind, message: string, opts: ProviderErrorOptions) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.ambiguous = opts.ambiguous;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.details = opts.details;
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/** Registry of instantiated providers keyed by name. */
export class ProviderRegistry {
  private readonly providers = new Map<string, SocialProvider>();

  constructor(providers: SocialProvider[] = []) {
    for (const p of providers) this.register(p);
  }

  register(provider: SocialProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): SocialProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider not registered: ${name}`);
    return p;
  }

  names(): string[] {
    return [...this.providers.keys()];
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
