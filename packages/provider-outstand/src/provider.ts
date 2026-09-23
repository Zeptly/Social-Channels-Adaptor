import type {
  CredentialsConnectionInput,
  InitiateConnectionInput,
  PendingConnection,
  PreparedUpload,
  ProviderAccount,
  ProviderConversation,
  ProviderMedia,
  ProviderMessage,
  ProviderPage,
  ProviderPostMetrics,
  ProviderPostState,
  ProviderPublishRequest,
  SocialProvider,
} from "@zeptly-social/provider-contract";
import { ProviderError } from "@zeptly-social/provider-contract";
import { type Logger, registerSecret } from "@zeptly-social/observability";
import { z } from "zod";
import { OutstandHttp, PROVIDER, unwrap } from "./http.js";
import { OutstandWebhookVerifier } from "./webhooks.js";
import {
  buildCreatePostBody,
  extractPost,
  mapAccount,
  mapAccountList,
  mapAnalytics,
  mapConversation,
  mapMedia,
  mapMessage,
  mapPending,
  mapPost,
  wireUploadUrlSchema,
} from "./wire.js";

export interface OutstandProviderOptions {
  apiKey: string;
  webhookSecret: string;
  baseUrl?: string;
  schedulingHorizonDays?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  requestId?: () => string | undefined;
  /** Clock (injectable for tests). */
  now?: () => Date;
}

export const DEFAULT_OUTSTAND_BASE_URL = "https://api.outstand.so/v1";
const PAGE = 50;

/**
 * OutstandProvider — the only V1 SocialProvider. Server-side only; the API key
 * never leaves this process and is registered for value-level log redaction.
 */
export class OutstandProvider implements SocialProvider {
  readonly name = "outstand" as const;
  readonly schedulingHorizonMs: number;
  readonly webhooks: OutstandWebhookVerifier;
  private readonly http: OutstandHttp;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: OutstandProviderOptions) {
    registerSecret(opts.apiKey);
    registerSecret(opts.webhookSecret);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
    this.http = new OutstandHttp({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? DEFAULT_OUTSTAND_BASE_URL,
      timeoutMs: this.timeoutMs,
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.retryBaseMs !== undefined ? { retryBaseMs: opts.retryBaseMs } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    });
    this.webhooks = new OutstandWebhookVerifier(opts.webhookSecret);
    this.schedulingHorizonMs = (opts.schedulingHorizonDays ?? 30) * 86_400_000;
  }

  /* ----------------------------- accounts ---------------------------- */

  async checkCredentials(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.http.request(`/social-accounts?limit=1&offset=0`);
      return { ok: true, message: "Outstand API key accepted" };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth") return { ok: false, message: "Outstand rejected the API key" };
      if (err instanceof ProviderError) return { ok: false, message: err.message };
      throw err;
    }
  }

  async initiateConnection(input: InitiateConnectionInput): Promise<{ authorizationUrl: string }> {
    const json = await this.http.request(`/social-networks/${encodeURIComponent(input.network)}/auth-url`, {
      method: "POST",
      body: { redirect_uri: input.redirectUri, tenant_id: input.tenantRef },
    });
    const data = z.object({ auth_url: z.url() }).loose().parse(unwrap(json));
    return { authorizationUrl: data.auth_url };
  }

  /**
   * Bluesky app-password connect (`POST /social-accounts/bluesky`). The
   * credentials are sent once over TLS and never stored or logged.
   */
  async connectWithCredentials(input: CredentialsConnectionInput): Promise<ProviderAccount[]> {
    if (input.network !== "bluesky") {
      throw new ProviderError(PROVIDER, "unsupported", `Credential connection is not supported for ${input.network}`, { retryable: false, ambiguous: false });
    }
    const json = await this.http.request(`/social-accounts/bluesky`, {
      method: "POST",
      body: { handle: input.credentials.handle, app_password: input.credentials.appPassword, tenant_id: input.tenantRef },
      mutating: true,
    });
    return mapAccountList(unwrap(json));
  }

  async getPendingConnection(sessionToken: string): Promise<PendingConnection> {
    const json = await this.http.request(`/social-accounts/pending/${encodeURIComponent(sessionToken)}`);
    return mapPending(unwrap(json));
  }

  async finalizeConnection(sessionToken: string, optionIds: string[]): Promise<ProviderAccount[]> {
    const json = await this.http.request(`/social-accounts/pending/${encodeURIComponent(sessionToken)}/finalize`, {
      method: "POST",
      body: { selectedPageIds: optionIds },
      mutating: true,
    });
    return mapAccountList(unwrap(json));
  }

  async listAccounts(filter: { tenantRef?: string } = {}): Promise<ProviderAccount[]> {
    const out: ProviderAccount[] = [];
    for (let offset = 0; offset < 10_000; offset += PAGE) {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (filter.tenantRef) qs.set("tenantId", filter.tenantRef);
      const json = await this.http.request(`/social-accounts?${qs.toString()}`);
      const page = z.array(z.unknown()).parse(unwrap(json) ?? []);
      out.push(...page.map(mapAccount));
      if (page.length < PAGE) break;
    }
    return out;
  }

  async disconnectAccount(accountExternalId: string): Promise<void> {
    try {
      await this.http.request(`/social-accounts/${encodeURIComponent(accountExternalId)}`, { method: "DELETE" });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "not_found") return;
      throw err;
    }
  }

  /* ------------------------------- media ----------------------------- */

  async prepareUpload(input: { filename: string; contentType: string }): Promise<PreparedUpload> {
    const json = await this.http.request("/media/upload", {
      method: "POST",
      body: { filename: input.filename, content_type: input.contentType },
      mutating: true,
    });
    const d = wireUploadUrlSchema.parse(unwrap(json));
    return { externalId: d.id, uploadUrl: d.upload_url, expiresAt: new Date(this.now().getTime() + (d.expires_in ?? 900) * 1000) };
  }

  async confirmUpload(input: { externalId: string; filename: string; sizeBytes?: number }): Promise<ProviderMedia> {
    const json = await this.http.request(`/media/${encodeURIComponent(input.externalId)}/confirm`, {
      method: "POST",
      body: input.sizeBytes ? { size: input.sizeBytes } : {},
      mutating: true,
    });
    return mapMedia(unwrap(json), input.filename);
  }

  /**
   * Fetches a durable source URL and streams it to Outstand's presigned upload
   * URL (no blob touches PostgreSQL). The caller has already validated the URL
   * (HTTPS, public host); redirects are refused here to prevent SSRF pivots.
   */
  async uploadFromUrl(input: { sourceUrl: string; filename: string; contentType: string; maxBytes: number }): Promise<ProviderMedia> {
    let src: Response;
    try {
      src = await this.http.fetchImpl(input.sourceUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(Math.max(this.timeoutMs, 300_000)) });
    } catch {
      throw new ProviderError(PROVIDER, "network", "Media source URL could not be fetched", { retryable: true, ambiguous: false });
    }
    if (src.status >= 300 && src.status < 400) {
      throw new ProviderError(PROVIDER, "validation", "Media source URL redirects; supply the final durable URL", { status: src.status, retryable: false, ambiguous: false });
    }
    if (!src.ok || !src.body) {
      throw new ProviderError(PROVIDER, src.status >= 500 ? "server" : "validation", `Media source URL returned HTTP ${src.status}`, {
        status: src.status,
        retryable: src.status >= 500,
        ambiguous: false,
      });
    }
    const declared = Number(src.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > input.maxBytes) {
      await src.body.cancel();
      throw new ProviderError(PROVIDER, "validation", `Media exceeds the ${input.maxBytes}-byte limit`, { retryable: false, ambiguous: false });
    }
    // Presigned object-store PUTs need a known length; buffer (bounded) when the source omits it.
    const bytes = await readBounded(src.body, input.maxBytes);
    const prepared = await this.prepareUpload({ filename: input.filename, contentType: input.contentType });
    let put: Response;
    try {
      put = await this.http.fetchImpl(prepared.uploadUrl, {
        method: "PUT",
        body: bytes,
        headers: { "Content-Type": input.contentType },
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 300_000)),
      });
    } catch {
      throw new ProviderError(PROVIDER, "network", "Upload to Outstand media storage failed", { retryable: true, ambiguous: false });
    }
    if (!put.ok) {
      throw new ProviderError(PROVIDER, put.status >= 500 ? "server" : "validation", `Outstand media storage rejected the upload (HTTP ${put.status})`, {
        status: put.status,
        retryable: put.status >= 500,
        ambiguous: false,
      });
    }
    return this.confirmUpload({ externalId: prepared.externalId, filename: input.filename, sizeBytes: bytes.byteLength });
  }

  /* ------------------------------- posts ----------------------------- */

  async publish(input: ProviderPublishRequest): Promise<ProviderPostState> {
    const { scheduledAt: _ignored, ...immediate } = input;
    return this.createPost(immediate);
  }

  async schedule(input: ProviderPublishRequest & { scheduledAt: Date }): Promise<ProviderPostState> {
    if (input.scheduledAt.getTime() - this.now().getTime() > this.schedulingHorizonMs) {
      throw new ProviderError(PROVIDER, "validation", "scheduledAt lies beyond the Outstand scheduling horizon", { retryable: false, ambiguous: false });
    }
    return this.createPost(input);
  }

  private async createPost(input: ProviderPublishRequest): Promise<ProviderPostState> {
    const json = await this.http.request("/posts/", {
      method: "POST",
      body: buildCreatePostBody(input),
      idempotencyKey: input.idempotencyKey,
      mutating: true,
      timeoutMs: Math.max(this.timeoutMs, 60_000),
    });
    return mapPost(extractPost(json));
  }

  async getPost(externalId: string): Promise<ProviderPostState> {
    const json = await this.http.request(`/posts/${encodeURIComponent(externalId)}`);
    return mapPost(extractPost(json));
  }

  async deletePost(externalId: string): Promise<void> {
    try {
      await this.http.request(`/posts/${encodeURIComponent(externalId)}`, { method: "DELETE", mutating: true });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "not_found") return;
      throw err;
    }
  }

  async getMetrics(postExternalId: string): Promise<ProviderPostMetrics[]> {
    const json = await this.http.request(`/posts/${encodeURIComponent(postExternalId)}/analytics`);
    return mapAnalytics(json);
  }

  /* --------------------------- conversations ------------------------- */

  async listConversations(input: { accountExternalId: string; cursor?: string }): Promise<ProviderPage<ProviderConversation>> {
    const offset = Number(input.cursor ?? 0) || 0;
    const qs = new URLSearchParams({ social_account_id: input.accountExternalId, limit: String(PAGE), offset: String(offset) });
    const json = await this.http.request(`/conversations?${qs.toString()}`);
    const items = z.array(z.unknown()).parse(unwrap(json) ?? []).map((c) => mapConversation(c, input.accountExternalId));
    return { items, ...(items.length === PAGE ? { nextCursor: String(offset + PAGE) } : {}) };
  }

  async listMessages(input: { conversationExternalId: string; cursor?: string }): Promise<ProviderPage<ProviderMessage>> {
    const offset = Number(input.cursor ?? 0) || 0;
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    const json = await this.http.request(`/conversations/${encodeURIComponent(input.conversationExternalId)}/messages?${qs.toString()}`);
    const items = z.array(z.unknown()).parse(unwrap(json) ?? []).map((m) => mapMessage(m, input.conversationExternalId));
    return { items, ...(items.length === PAGE ? { nextCursor: String(offset + PAGE) } : {}) };
  }

  async sendMessage(input: { conversationExternalId: string; text: string; idempotencyKey: string }): Promise<ProviderMessage> {
    const json = await this.http.request(`/conversations/${encodeURIComponent(input.conversationExternalId)}/messages`, {
      method: "POST",
      body: { text: input.text },
      idempotencyKey: input.idempotencyKey,
      mutating: true,
    });
    const data = unwrap(json);
    const msg = data && typeof data === "object" && "message" in data ? (data as { message: unknown }).message : data;
    return mapMessage({ direction: "outbound", ...(msg as Record<string, unknown>) }, input.conversationExternalId);
  }
}

async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ProviderError(PROVIDER, "validation", `Media exceeds the ${maxBytes}-byte limit`, { retryable: false, ambiguous: false });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
