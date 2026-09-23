/**
 * Outstand wire shapes ↔ provider-contract types. Pure functions, no I/O.
 *
 * Sources (docs/OUTSTAND.md → Evidence): official `@outstand-so/ui` v0.1.13
 * wire types, the Outstand-UI reference implementation (verified webhook
 * contract, live-probed `accounts` create-post key), and Outstand's public docs.
 * Parsing tolerates unknown fields and snake/camel variations but enforces the
 * identifiers we depend on. Token-bearing fields (e.g. socialAccounts[].network_data)
 * are never lifted out of the wire object.
 */
import type {
  PendingConnection,
  ProviderAccount,
  ProviderConversation,
  ProviderMedia,
  ProviderMessage,
  ProviderPostMetrics,
  ProviderPostState,
  ProviderPublishRequest,
  ProviderTargetStatus,
} from "@zeptly-social/provider-contract";
import type { SocialNetwork } from "@zeptly-social/domain";
import { z } from "zod";
import { envelopeSchema } from "./http.js";

const optStr = z
  .string()
  .nullish()
  .transform((v) => (v === null || v === undefined || v === "" ? undefined : v));
const idSchema = z.union([z.string().trim().min(1), z.number().int().nonnegative()]).transform((v) => String(v));

function date(v: string | number | null | undefined): Date | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export const wireAccountSchema = z
  .object({
    id: idSchema,
    network: z.string(),
    username: optStr,
    nickname: optStr,
    profile_picture_url: optStr,
    accountType: optStr,
    isActive: z.union([z.number(), z.boolean()]).nullish(),
    tenantId: optStr,
  })
  .loose();

export function mapAccount(raw: unknown): ProviderAccount {
  const a = wireAccountSchema.parse(raw);
  const type = a.accountType === "organization" || a.accountType === "personal" ? a.accountType : undefined;
  return {
    externalId: a.id,
    network: a.network.toLowerCase(),
    ...(a.username ? { username: a.username } : {}),
    ...(a.nickname ? { displayName: a.nickname } : {}),
    ...(a.profile_picture_url ? { avatarUrl: a.profile_picture_url } : {}),
    ...(type ? { accountType: type } : {}),
    isActive: a.isActive === null || a.isActive === undefined ? true : Boolean(a.isActive),
    ...(a.tenantId ? { tenantRef: a.tenantId } : {}),
  };
}

export const wirePendingSchema = z
  .object({
    network: z.string(),
    expiresAt: z.union([z.number(), z.string()]).nullish(),
    availablePages: z
      .array(
        z
          .object({
            id: idSchema,
            type: optStr,
            name: optStr,
            username: optStr,
            profilePictureUrl: optStr,
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

export function mapPending(raw: unknown): PendingConnection {
  const p = wirePendingSchema.parse(raw);
  const expiresAt = date(p.expiresAt ?? undefined);
  return {
    network: p.network.toLowerCase(),
    ...(expiresAt ? { expiresAt } : {}),
    options: p.availablePages.map((pg) => ({
      id: pg.id,
      name: pg.name ?? pg.username ?? pg.id,
      ...(pg.username ? { username: pg.username } : {}),
      ...(pg.type === "organization" || pg.type === "personal" ? { type: pg.type } : {}),
      ...(pg.profilePictureUrl ? { avatarUrl: pg.profilePictureUrl } : {}),
    })),
  };
}

/** Finalize returns `{ connectedAccounts: [...] }`; credential connect may return an account or a list. */
export function mapAccountList(data: unknown): ProviderAccount[] {
  if (Array.isArray(data)) return data.map(mapAccount);
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["connectedAccounts", "accounts", "account"]) {
      const v = o[key];
      if (Array.isArray(v)) return v.map(mapAccount);
      if (v && typeof v === "object") return [mapAccount(v)];
    }
    if ("id" in o && "network" in o) return [mapAccount(o)];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

export const wireUploadUrlSchema = z
  .object({ id: idSchema, upload_url: z.url(), expires_in: z.number().nullish() })
  .loose();

export const wireMediaSchema = z
  .object({
    id: idSchema,
    url: z.string().min(1),
    filename: optStr,
    content_type: optStr,
    contentType: optStr,
    size: z.number().nullish(),
    expires_at: optStr,
  })
  .loose();

export function mapMedia(raw: unknown, fallbackFilename: string): ProviderMedia {
  const m = wireMediaSchema.parse(raw);
  const expiresAt = date(m.expires_at);
  const contentType = m.content_type ?? m.contentType;
  return {
    externalId: m.id,
    url: m.url,
    filename: m.filename ?? fallbackFilename,
    ...(contentType ? { contentType } : {}),
    ...(typeof m.size === "number" ? { sizeBytes: m.size } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Posts                                                               */
/* ------------------------------------------------------------------ */

export const wirePostAccountSchema = z
  .object({
    id: idSchema,
    network: optStr,
    username: optStr,
    status: optStr,
    error: optStr,
    platformPostId: optStr,
    platformPostUrl: optStr,
    publishedAt: optStr,
  })
  .loose();

export const wirePostSchema = z
  .object({
    id: idSchema,
    publishedAt: optStr,
    scheduledAt: optStr,
    socialAccounts: z.array(z.union([wirePostAccountSchema, idSchema])).nullish(),
  })
  .loose();

export function mapTargetStatus(s: string | undefined): ProviderTargetStatus {
  switch ((s ?? "").toLowerCase()) {
    case "pending":
    case "scheduled":
    case "processing":
    case "queued":
      return "pending";
    case "published":
    case "success":
      return "published";
    case "failed":
    case "error":
      return "failed";
    case "deleted":
      return "deleted";
    default:
      return "unknown";
  }
}

/** Accepts `data`, `data.post`, `{post}` or a bare post (envelope variations observed live). */
export function extractPost(body: unknown): unknown {
  const env = envelopeSchema.safeParse(body);
  let data: unknown = env.success && env.data.data !== undefined ? env.data.data : body;
  if (data && typeof data === "object" && "post" in data && (data as { post?: unknown }).post) data = (data as { post: unknown }).post;
  return data;
}

export function mapPost(raw: unknown): ProviderPostState {
  const p = wirePostSchema.parse(raw);
  const scheduledAt = date(p.scheduledAt);
  const publishedAt = date(p.publishedAt);
  return {
    externalId: p.id,
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    // Allowlist mapping: only non-secret fields are lifted (network_data tokens are dropped).
    targets: (p.socialAccounts ?? []).map((sa) => {
      if (typeof sa === "string") return { accountExternalId: sa, status: "unknown" as const };
      const pa = date(sa.publishedAt);
      return {
        accountExternalId: sa.id,
        status: mapTargetStatus(sa.status),
        ...(sa.platformPostId ? { platformPostId: sa.platformPostId } : {}),
        ...(sa.platformPostUrl ? { platformPostUrl: sa.platformPostUrl } : {}),
        ...(sa.error ? { error: sa.error } : {}),
        ...(pa ? { publishedAt: pa } : {}),
      };
    }),
  };
}

export interface OutstandCreatePostBody {
  containers: Array<{ content: string; media?: Array<{ id: string; url: string; filename: string }> }>;
  /** Live API requires `accounts` (docs mention socialAccountIds; rejected live — docs/OUTSTAND.md). */
  accounts: string[];
  scheduledAt?: string;
  threads?: Record<string, unknown>;
  instagram?: Record<string, unknown>;
  youtube?: Record<string, unknown>;
  tiktok?: Record<string, unknown>;
  pinterest?: Record<string, unknown>;
  facebook?: Record<string, unknown>;
}

function pick(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

/** Canonical target options → Outstand per-network option block (only evidenced keys). */
export function networkOptions(network: SocialNetwork, options: Record<string, unknown>): Partial<OutstandCreatePostBody> {
  switch (network) {
    case "threads": {
      const o = pick(options, ["replyControl"]);
      return Object.keys(o).length ? { threads: o } : {};
    }
    case "instagram": {
      const o = pick(options, ["mediaType", "shareToFeed", "isAiGenerated"]);
      return Object.keys(o).length ? { instagram: o } : {};
    }
    case "youtube": {
      const o = pick(options, ["title", "privacyStatus", "categoryId", "tags"]);
      return Object.keys(o).length ? { youtube: o } : {};
    }
    case "tiktok": {
      const o = pick(options, ["privacyLevel", "disableDuet", "disableStitch", "disableComment"]);
      return Object.keys(o).length ? { tiktok: o } : {};
    }
    case "facebook": {
      const o = pick(options, ["publishAsReel", "publishAsStory"]);
      return Object.keys(o).length ? { facebook: o } : {};
    }
    case "pinterest": {
      const boardId = options.boardId;
      return typeof boardId === "string" && boardId ? { pinterest: { board_id: boardId } } : {};
    }
    default:
      return {};
  }
}

export function buildCreatePostBody(input: ProviderPublishRequest): OutstandCreatePostBody {
  if (input.accountExternalIds.length === 0) throw new Error("At least one target account is required");
  const body: OutstandCreatePostBody = {
    containers: [
      {
        content: input.text,
        ...(input.media.length ? { media: input.media.map((m) => ({ id: m.externalId, url: m.url, filename: m.filename })) } : {}),
      },
    ],
    accounts: [...input.accountExternalIds],
    ...networkOptions(input.network, input.options),
  };
  if (input.scheduledAt) body.scheduledAt = input.scheduledAt.toISOString();
  return body;
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

const STANDARD_METRICS = ["likes", "comments", "shares", "reach", "saves", "views", "impressions"] as const;

export const wireAnalyticsSchema = z
  .object({
    metrics_by_account: z
      .array(
        z
          .object({
            social_account: z.object({ id: idSchema, network: optStr }).loose(),
            platform_post_id: optStr,
            metrics: z.record(z.string(), z.unknown()).default({}),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

function finiteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Only metrics Outstand actually reports are emitted (absent ≠ 0). Standard names
 * come first; any other numeric metric Outstand adds (e.g. Reels views, Story
 * metrics, fuller Facebook insights) is passed through under its reported name;
 * `platform_specific` values are kept under `platform.<key>`.
 */
export function mapAnalytics(raw: unknown): ProviderPostMetrics[] {
  const body = extractAnalytics(raw);
  const a = wireAnalyticsSchema.parse(body);
  return a.metrics_by_account.map((m) => {
    const metrics: ProviderPostMetrics["metrics"] = [];
    for (const name of STANDARD_METRICS) {
      const v = finiteNumber(m.metrics[name]);
      if (v !== undefined) metrics.push({ name, value: v });
    }
    const standard: ReadonlySet<string> = new Set<string>(STANDARD_METRICS);
    for (const name of Object.keys(m.metrics).sort()) {
      if (standard.has(name) || name === "platform_specific") continue;
      const v = typeof m.metrics[name] === "number" ? finiteNumber(m.metrics[name]) : undefined;
      if (v !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(name)) metrics.push({ name, value: v });
    }
    const ps = m.metrics.platform_specific;
    if (ps && typeof ps === "object") {
      for (const [k, v] of Object.entries(ps as Record<string, unknown>)) {
        const n = finiteNumber(v);
        if (n !== undefined) metrics.push({ name: `platform.${k}`, value: n });
      }
    }
    return {
      accountExternalId: m.social_account.id,
      ...(m.social_account.network ? { network: m.social_account.network } : {}),
      ...(m.platform_post_id ? { platformPostId: m.platform_post_id } : {}),
      metrics,
    };
  });
}

function extractAnalytics(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "metrics_by_account" in raw) return raw;
  const env = envelopeSchema.safeParse(raw);
  return env.success && env.data.data !== undefined ? env.data.data : raw;
}

/* ------------------------------------------------------------------ */
/* Conversations (Instagram DMs) — tolerant, see docs/OUTSTAND.md      */
/* ------------------------------------------------------------------ */

const wireParticipantSchema = z
  .object({
    id: idSchema.optional(),
    name: optStr,
    username: optStr,
    profile_picture_url: optStr,
    profilePictureUrl: optStr,
  })
  .loose();

export const wireMessageSchema = z
  .object({
    id: idSchema,
    conversation_id: idSchema.optional(),
    conversationId: idSchema.optional(),
    direction: optStr,
    is_from_business: z.boolean().nullish(),
    status: optStr,
    text: optStr,
    content: optStr,
    attachments: z.array(z.object({ type: optStr, url: optStr }).loose()).nullish(),
    created_at: optStr,
    createdAt: optStr,
    sent_at: optStr,
    error: optStr,
  })
  .loose();

export const wireConversationSchema = z
  .object({
    id: idSchema,
    social_account_id: idSchema.optional(),
    socialAccountId: idSchema.optional(),
    accountId: idSchema.optional(),
    participant: wireParticipantSchema.nullish(),
    contact: wireParticipantSchema.nullish(),
    last_message_at: optStr,
    lastMessageAt: optStr,
    last_message: z.object({ text: optStr }).loose().nullish(),
  })
  .loose();

export function mapMessage(raw: unknown, fallbackConversationId?: string): ProviderMessage {
  const m = wireMessageSchema.parse(raw);
  const dir = (m.direction ?? "").toLowerCase();
  const direction: ProviderMessage["direction"] =
    dir === "outbound" || dir === "sent" || m.is_from_business === true ? "outbound" : "inbound";
  const s = (m.status ?? "").toLowerCase();
  const status: ProviderMessage["status"] =
    s === "failed" || s === "error" ? "failed" : direction === "inbound" ? "received" : s === "pending" || s === "sending" ? "sending" : "sent";
  const conversationExternalId = m.conversation_id ?? m.conversationId ?? fallbackConversationId;
  if (!conversationExternalId) throw new Error("message without conversation id");
  const sentAt = date(m.sent_at ?? m.created_at ?? m.createdAt);
  const text = m.text ?? m.content;
  return {
    externalId: m.id,
    conversationExternalId,
    direction,
    status,
    ...(text ? { text } : {}),
    attachments: (m.attachments ?? []).map((a) => ({ type: a.type ?? "file", ...(a.url ? { url: a.url } : {}) })),
    ...(sentAt ? { sentAt } : {}),
    ...(m.error ? { error: m.error } : {}),
  };
}

export function mapConversation(raw: unknown, fallbackAccountId?: string): ProviderConversation {
  const c = wireConversationSchema.parse(raw);
  const p: Partial<z.infer<typeof wireParticipantSchema>> = c.participant ?? c.contact ?? {};
  const accountExternalId = c.social_account_id ?? c.socialAccountId ?? c.accountId ?? fallbackAccountId;
  if (!accountExternalId) throw new Error("conversation without account id");
  const lastMessageAt = date(c.last_message_at ?? c.lastMessageAt);
  const preview = c.last_message?.text;
  const avatar = p.profile_picture_url ?? p.profilePictureUrl;
  return {
    externalId: c.id,
    accountExternalId,
    participant: {
      ...(p.id ? { externalId: p.id } : {}),
      ...(p.name ? { displayName: p.name } : {}),
      ...(p.username ? { username: p.username } : {}),
      ...(avatar ? { avatarUrl: avatar } : {}),
    },
    ...(lastMessageAt ? { lastMessageAt } : {}),
    ...(preview ? { lastMessagePreview: preview.slice(0, 280) } : {}),
  };
}
