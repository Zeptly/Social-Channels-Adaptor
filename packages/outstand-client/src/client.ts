import { OutstandError } from "./errors.js";
import type {
  OutstandAccount,
  OutstandConversation,
  OutstandCreatePostInput,
  OutstandMedia,
  OutstandMessage,
  OutstandPage,
  OutstandPendingConnection,
  OutstandPostMetrics,
  OutstandPostState,
  OutstandPreparedUpload,
  OutstandUpdatePostInput,
} from "./types.js";
import { type Logger, registerSecret } from "@zeptly-gateway/observability";
import { z } from "zod";
import { OutstandHttp, unwrap } from "./http.js";
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

export interface OutstandClientOptions {
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
  /**
   * Enable in-place edits via PATCH /posts/{id} (Outstand "Update a post").
   * Off by default until verified by the live suite (docs/OUTSTAND.md).
   */
  enablePostUpdate?: boolean;
  /** Clock (injectable for tests). */
  now?: () => Date;
}

export const DEFAULT_OUTSTAND_BASE_URL = "https://api.outstand.so/v1";
const PAGE = 50;

/**
 * OutstandClient — the ONLY component that speaks Outstand's HTTP API.
 * Server-side only; the API key never leaves this process and is registered
 * for value-level log redaction. Returns typed, sanitized results (types.ts);
 * raw wire objects never leave this package.
 */
export class OutstandClient {
  readonly provider = "outstand" as const;
  readonly schedulingHorizonMs: number;
  readonly webhooks: OutstandWebhookVerifier;
  readonly supportsPostUpdate: boolean;
  private readonly http: OutstandHttp;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: OutstandClientOptions) {
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
    this.supportsPostUpdate = opts.enablePostUpdate ?? false;
  }

  /* ----------------------------- accounts ---------------------------- */

  async checkCredentials(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.http.request(`/social-accounts?limit=1&offset=0`);
      return { ok: true, message: "Outstand API key accepted" };
    } catch (err) {
      if (err instanceof OutstandError && err.kind === "auth") return { ok: false, message: "Outstand rejected the API key" };
      if (err instanceof OutstandError) return { ok: false, message: err.message };
      throw err;
    }
  }

  async initiateConnection(input: { network: string; redirectUri: string; tenantRef: string }): Promise<{ authorizationUrl: string }> {
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
  async connectWithCredentials(input: { network: string; tenantRef: string; credentials: { handle: string; appPassword: string } }): Promise<OutstandAccount[]> {
    if (input.network !== "bluesky") {
      throw new OutstandError("unsupported", `Credential connection is not supported for ${input.network}`, { retryable: false, ambiguous: false });
    }
    const json = await this.http.request(`/social-accounts/bluesky`, {
      method: "POST",
      body: { handle: input.credentials.handle, app_password: input.credentials.appPassword, tenant_id: input.tenantRef },
      mutating: true,
    });
    return mapAccountList(unwrap(json));
  }

  async getPendingConnection(sessionToken: string): Promise<OutstandPendingConnection> {
    const json = await this.http.request(`/social-accounts/pending/${encodeURIComponent(sessionToken)}`);
    return mapPending(unwrap(json));
  }

  async finalizeConnection(sessionToken: string, optionIds: string[]): Promise<OutstandAccount[]> {
    const json = await this.http.request(`/social-accounts/pending/${encodeURIComponent(sessionToken)}/finalize`, {
      method: "POST",
      body: { selectedPageIds: optionIds },
      mutating: true,
    });
    return mapAccountList(unwrap(json));
  }

  async listAccounts(filter: { tenantRef?: string } = {}): Promise<OutstandAccount[]> {
    const out: OutstandAccount[] = [];
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
      if (err instanceof OutstandError && err.kind === "not_found") return;
      throw err;
    }
  }

  /* ------------------------------- media ----------------------------- */

  async prepareUpload(input: { filename: string; contentType: string }): Promise<OutstandPreparedUpload> {
    const json = await this.http.request("/media/upload", {
      method: "POST",
      body: { filename: input.filename, content_type: input.contentType },
      mutating: true,
    });
    const d = wireUploadUrlSchema.parse(unwrap(json));
    return { externalId: d.id, uploadUrl: d.upload_url, expiresAt: new Date(this.now().getTime() + (d.expires_in ?? 900) * 1000) };
  }

  async confirmUpload(input: { externalId: string; filename: string; sizeBytes?: number }): Promise<OutstandMedia> {
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
  async uploadFromUrl(input: { sourceUrl: string; filename: string; contentType: string; maxBytes: number }): Promise<OutstandMedia> {
    let src: Response;
    try {
      src = await this.http.fetchImpl(input.sourceUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(Math.max(this.timeoutMs, 300_000)) });
    } catch {
      throw new OutstandError("network", "Media source URL could not be fetched", { retryable: true, ambiguous: false });
    }
    if (src.status >= 300 && src.status < 400) {
      throw new OutstandError("validation", "Media source URL redirects; supply the final durable URL", { status: src.status, retryable: false, ambiguous: false });
    }
    if (!src.ok || !src.body) {
      throw new OutstandError(src.status >= 500 ? "server" : "validation", `Media source URL returned HTTP ${src.status}`, {
        status: src.status,
        retryable: src.status >= 500,
        ambiguous: false,
      });
    }
    const declared = Number(src.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > input.maxBytes) {
      await src.body.cancel();
      throw new OutstandError("validation", `Media exceeds the ${input.maxBytes}-byte limit`, { retryable: false, ambiguous: false });
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
      throw new OutstandError("network", "Upload to Outstand media storage failed", { retryable: true, ambiguous: false });
    }
    if (!put.ok) {
      throw new OutstandError(put.status >= 500 ? "server" : "validation", `Outstand media storage rejected the upload (HTTP ${put.status})`, {
        status: put.status,
        retryable: put.status >= 500,
        ambiguous: false,
      });
    }
    return this.confirmUpload({ externalId: prepared.externalId, filename: input.filename, sizeBytes: bytes.byteLength });
  }

  /* ------------------------------- posts ----------------------------- */

  async publish(input: OutstandCreatePostInput): Promise<OutstandPostState> {
    const { scheduledAt: _ignored, ...immediate } = input;
    return this.createPost(immediate);
  }

  async schedule(input: OutstandCreatePostInput & { scheduledAt: Date }): Promise<OutstandPostState> {
    if (input.scheduledAt.getTime() - this.now().getTime() > this.schedulingHorizonMs) {
      throw new OutstandError("validation", "scheduledAt lies beyond the Outstand scheduling horizon", { retryable: false, ambiguous: false });
    }
    return this.createPost(input);
  }

  private async createPost(input: OutstandCreatePostInput): Promise<OutstandPostState> {
    const json = await this.http.request("/posts/", {
      method: "POST",
      body: buildCreatePostBody(input),
      idempotencyKey: input.idempotencyKey,
      mutating: true,
      timeoutMs: Math.max(this.timeoutMs, 60_000),
    });
    return mapPost(extractPost(json));
  }

  /**
   * PATCH /posts/{id}: edit copy, media, options or time of an unpublished post
   * while keeping the same Outstand post reference. Accounts are not changed.
   */
  async updatePost(externalId: string, input: OutstandUpdatePostInput): Promise<OutstandPostState> {
    if (!this.supportsPostUpdate) {
      throw new OutstandError("unsupported", "Outstand post update is not enabled", { retryable: false, ambiguous: false });
    }
    if (input.scheduledAt.getTime() - this.now().getTime() > this.schedulingHorizonMs) {
      throw new OutstandError("validation", "scheduledAt lies beyond the Outstand scheduling horizon", { retryable: false, ambiguous: false });
    }
    const { accounts: _accounts, ...body } = buildCreatePostBody({ ...input, idempotencyKey: "", accountExternalIds: ["_"] });
    const json = await this.http.request(`/posts/${encodeURIComponent(externalId)}`, { method: "PATCH", body, mutating: true });
    return mapPost(extractPost(json));
  }

  async getPost(externalId: string): Promise<OutstandPostState> {
    const json = await this.http.request(`/posts/${encodeURIComponent(externalId)}`);
    return mapPost(extractPost(json));
  }

  async deletePost(externalId: string): Promise<void> {
    try {
      await this.http.request(`/posts/${encodeURIComponent(externalId)}`, { method: "DELETE", mutating: true });
    } catch (err) {
      if (err instanceof OutstandError && err.kind === "not_found") return;
      throw err;
    }
  }

  async getMetrics(postExternalId: string): Promise<OutstandPostMetrics[]> {
    const json = await this.http.request(`/posts/${encodeURIComponent(postExternalId)}/analytics`);
    return mapAnalytics(json);
  }

  /* --------------------------- conversations ------------------------- */

  async listConversations(input: { accountExternalId: string; cursor?: string }): Promise<OutstandPage<OutstandConversation>> {
    const offset = Number(input.cursor ?? 0) || 0;
    const qs = new URLSearchParams({ social_account_id: input.accountExternalId, limit: String(PAGE), offset: String(offset) });
    const json = await this.http.request(`/conversations?${qs.toString()}`);
    const items = z.array(z.unknown()).parse(unwrap(json) ?? []).map((c) => mapConversation(c, input.accountExternalId));
    return { items, ...(items.length === PAGE ? { nextCursor: String(offset + PAGE) } : {}) };
  }

  async listMessages(input: { conversationExternalId: string; cursor?: string }): Promise<OutstandPage<OutstandMessage>> {
    const offset = Number(input.cursor ?? 0) || 0;
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    const json = await this.http.request(`/conversations/${encodeURIComponent(input.conversationExternalId)}/messages?${qs.toString()}`);
    const items = z.array(z.unknown()).parse(unwrap(json) ?? []).map((m) => mapMessage(m, input.conversationExternalId));
    return { items, ...(items.length === PAGE ? { nextCursor: String(offset + PAGE) } : {}) };
  }

  async sendMessage(input: { conversationExternalId: string; text: string; idempotencyKey: string }): Promise<OutstandMessage> {
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
      throw new OutstandError("validation", `Media exceeds the ${maxBytes}-byte limit`, { retryable: false, ambiguous: false });
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
