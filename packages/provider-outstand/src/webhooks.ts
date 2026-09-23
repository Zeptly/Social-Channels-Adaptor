import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  type ParsedWebhook,
  type ProviderEvent,
  ProviderError,
  type SignatureCheck,
  type WebhookVerifier,
} from "@zeptly-social/provider-contract";
import { z } from "zod";
import { PROVIDER } from "./http.js";
import { mapConversation, mapMessage } from "./wire.js";

/**
 * Outstand webhook contract (verified against Outstand docs 2026-09-23 via the
 * reference implementation, ADR-0012 there; corroborated by pigfox/outstand-go):
 *
 *   X-Outstand-Signature: sha256=<hex HMAC-SHA256(raw body, secret)>
 *   Envelope: { event, timestamp, data }
 *   post.published        data { postId, orgId, socialAccounts[{ accountId, network, username, platformPostId, platformPostUrl }] }
 *                         → published to AT LEAST ONE account (not proof all succeeded)
 *   post.error            data { postId, orgId, socialAccounts[{ accountId, ..., error }] } → failed on all accounts
 *   account.token_expired data { orgId, accountId (number|string), network, username, error }
 *   test                  data { message, endpointId }
 *   conversation.started / message.received / message.sent / message.failed
 *                         → Instagram DMs; payload shape parsed tolerantly (docs/OUTSTAND.md).
 *   import.*              → acknowledged and ignored (imports are not used).
 */
export const SIGNATURE_HEADER = "x-outstand-signature";
const SIGNATURE_FORMAT = /^sha256=([0-9a-f]{64})$/i;

export function computeSignature(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): SignatureCheck {
  if (!secret) throw new Error("Outstand webhook secret is not configured");
  if (header === undefined || header.trim() === "") return "missing";
  const m = SIGNATURE_FORMAT.exec(header.trim());
  if (!m?.[1]) return "invalid";
  const got = Buffer.from(m[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (got.length !== expected.length) return "invalid";
  return timingSafeEqual(expected, got) ? "valid" : "invalid";
}

const nonEmpty = z.string().trim().min(1);
const accountId = z.union([nonEmpty, z.number().int().nonnegative()]).transform((v) => String(v));
const optStr = z
  .string()
  .nullish()
  .transform((v) => (v ? v : undefined));

const envelopeSchema = z
  .object({
    event: nonEmpty,
    timestamp: z.iso.datetime({ offset: true }),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .loose();

const postEventSchema = z
  .object({
    postId: z.union([nonEmpty, z.number()]).transform((v) => String(v)),
    socialAccounts: z
      .array(
        z
          .object({
            accountId,
            platformPostId: optStr,
            platformPostUrl: optStr,
            error: optStr,
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

const tokenExpiredSchema = z.object({ accountId, error: optStr }).loose();

const conversationEventSchema = z
  .object({
    accountId: accountId.optional(),
    socialAccountId: accountId.optional(),
    social_account_id: accountId.optional(),
    conversationId: accountId.optional(),
    conversation_id: accountId.optional(),
    conversation: z.record(z.string(), z.unknown()).optional(),
    message: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const CONVERSATION_EVENTS = new Set(["conversation.started", "message.received", "message.sent", "message.failed"]);

function issues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 300);
}

function protocol(message: string): ProviderError {
  return new ProviderError(PROVIDER, "protocol", message, { retryable: false, ambiguous: false });
}

export function parseWebhook(rawBody: Buffer): ParsedWebhook {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw protocol("webhook body is not JSON");
  }
  const env = envelopeSchema.safeParse(json);
  if (!env.success) throw protocol(`webhook envelope invalid: ${issues(env.error)}`);
  const { event: type, timestamp, data } = env.data;
  const occurredAt = new Date(timestamp);
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  // Dedupe identity recommended by Outstand: primary id + timestamp.
  const id = (primary: string | undefined) => (primary ? `evt:${type}:${primary}:${timestamp}` : `sha256:${bodyHash}`);

  if (type === "post.published" || type === "post.error") {
    const d = postEventSchema.safeParse(data);
    if (!d.success) throw protocol(`webhook data invalid: ${issues(d.error)}`);
    const event: ProviderEvent = {
      kind: "post_outcome",
      providerPostId: d.data.postId,
      occurredAt,
      accounts: d.data.socialAccounts.map((sa) => {
        const failed = Boolean(sa.error) || type === "post.error";
        return {
          accountExternalId: sa.accountId,
          outcome: failed ? "failed" : "published",
          ...(sa.platformPostId ? { platformPostId: sa.platformPostId } : {}),
          ...(sa.platformPostUrl ? { platformPostUrl: sa.platformPostUrl } : {}),
          ...(failed ? { error: sa.error ?? "Publishing failed on the network." } : {}),
        };
      }),
    };
    return { type, eventId: id(d.data.postId), event };
  }

  if (type === "account.token_expired") {
    const d = tokenExpiredSchema.safeParse(data);
    if (!d.success) throw protocol(`webhook data invalid: ${issues(d.error)}`);
    return {
      type,
      eventId: id(d.data.accountId),
      event: { kind: "account_reauthorization_required", accountExternalId: d.data.accountId, ...(d.data.error ? { reason: d.data.error } : {}), occurredAt },
    };
  }

  if (CONVERSATION_EVENTS.has(type)) {
    const d = conversationEventSchema.safeParse(data);
    if (!d.success) throw protocol(`webhook data invalid: ${issues(d.error)}`);
    const acct = d.data.accountId ?? d.data.socialAccountId ?? d.data.social_account_id;
    const convId = d.data.conversationId ?? d.data.conversation_id ?? (d.data.conversation?.id as string | number | undefined)?.toString();
    if (!acct || !convId) throw protocol("conversation webhook without account or conversation id");
    try {
      const conversation = mapConversation({ id: convId, ...(d.data.conversation ?? {}) }, acct);
      const message = d.data.message ? mapMessage(d.data.message, convId) : undefined;
      return {
        type,
        eventId: id(message ? `${convId}:${message.externalId}:${message.status}` : convId),
        event: { kind: "conversation_message", accountExternalId: acct, conversation, ...(message ? { message } : {}), occurredAt },
      };
    } catch (err) {
      throw protocol(`conversation webhook invalid: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  if (type === "test") return { type, eventId: id(String((data as { endpointId?: unknown }).endpointId ?? "")), event: { kind: "test", occurredAt } };
  return { type, eventId: id(undefined), event: { kind: "ignored", occurredAt } };
}

export class OutstandWebhookVerifier implements WebhookVerifier {
  readonly signatureHeader = SIGNATURE_HEADER;
  constructor(private readonly secret: string) {
    if (!secret) throw new Error("OUTSTAND_WEBHOOK_SECRET is required");
  }
  verify(rawBody: Buffer, header: string | undefined): SignatureCheck {
    return verifySignature(rawBody, header, this.secret);
  }
  parse(rawBody: Buffer): ParsedWebhook {
    return parseWebhook(rawBody);
  }
}
