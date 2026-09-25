import { z } from "zod";

/**
 * Audit envelope: every state-changing gateway operation produces one. Metadata
 * is redacted and never contains content bodies or credentials.
 */
export const AuditEnvelopeSchema = z
  .object({
    gateway: z.string(),
    workspaceId: z.string().nullable(),
    action: z.string().describe('Dotted verb, e.g. "connection.established"'),
    actor: z.object({ service: z.string(), agent: z.string().optional() }),
    resource: z.object({ type: z.string(), id: z.string() }).optional(),
    correlationId: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "AuditEnvelope" });
export type AuditEnvelope = z.infer<typeof AuditEnvelopeSchema>;

/**
 * Normalized inbound provider webhook. The gateway authenticates the raw bytes,
 * derives a deterministic `eventId` (redeliveries share it) and hands the
 * provider-neutral `event` to whichever capability claims its `kind`.
 * Ownership is never derived from an envelope: provider references inside
 * `event` are resolved through the gateway's stored mappings.
 */
export interface WebhookEnvelope<E extends { kind: string } = { kind: string }> {
  provider: string;
  /** Provider event type string, e.g. "post.published". */
  eventType: string;
  eventId: string;
  occurredAt: Date;
  event: E;
}

export type WebhookSignatureCheck = "valid" | "invalid" | "missing";

/** Receipt returned to the provider after authentication + durable storage. */
export const WebhookReceiptSchema = z
  .object({ accepted: z.boolean(), duplicate: z.boolean() })
  .meta({ id: "WebhookReceipt" });
export type WebhookReceipt = z.infer<typeof WebhookReceiptSchema>;
