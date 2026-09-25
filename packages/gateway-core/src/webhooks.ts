import { createHash } from "node:crypto";
import { GatewayError, type WebhookEnvelope, type WebhookReceipt, type WebhookSignatureCheck } from "@zeptly-gateway/gateway-contract";
import { webhookEvents } from "@zeptly-gateway/database";
import { redact, redactString } from "@zeptly-gateway/observability";
import { eq } from "drizzle-orm";
import { recordProviderEvent } from "./audit.js";
import type { WebhookEventHandler, WebhookHandlerResult } from "./capabilities.js";
import { type ConnectionsContext, markReauthorizationRequired } from "./connections.js";
import type { GatewayContext, SystemActor } from "./context.js";
import { enqueueJob } from "./jobs.js";
import { findAccountByExternalId } from "./tenancy.js";

/**
 * Webhook ingestion infrastructure. A gateway plugs in one `WebhookSource` per
 * provider (signature verification + interpretation into a WebhookEnvelope) and
 * capability modules plug in handlers keyed by `event.kind`.
 */
export interface WebhookSource {
  provider: string;
  signatureHeader: string;
  verify(rawBody: Buffer, signature: string | undefined): WebhookSignatureCheck;
  /** Throws on malformed payloads (after successful verification). */
  parse(rawBody: Buffer): WebhookEnvelope;
}

export interface WebhookContext extends GatewayContext {
  webhookSource: WebhookSource;
  webhookHandlers: WebhookEventHandler<never>[];
}

/** Event kinds owned by gateway infrastructure itself. */
export const GATEWAY_EVENT_KINDS = {
  accountReauthorizationRequired: "account.reauthorization_required",
  test: "gateway.test",
  ignored: "gateway.ignored",
} as const;

export interface AccountReauthorizationEvent {
  kind: typeof GATEWAY_EVENT_KINDS.accountReauthorizationRequired;
  accountExternalId: string;
  reason?: string;
}

/**
 * POST /v1/webhooks/:provider. Order: verify signature over the RAW bytes →
 * parse → deduplicate → persist receipt + enqueue processing (one transaction)
 * → 2xx. Nothing is persisted for an invalid signature, and no
 * webhook-controlled identifier is read before authentication.
 */
export async function receiveWebhook(ctx: WebhookContext, rawBody: Buffer, signature: string | undefined): Promise<WebhookReceipt & { eventId?: string }> {
  const source = ctx.webhookSource;
  const check = source.verify(rawBody, signature);
  if (check !== "valid") {
    ctx.logger.warn({ provider: source.provider, signature: check }, "webhook rejected: signature");
    throw new GatewayError("WEBHOOK_SIGNATURE_INVALID", "Webhook signature verification failed");
  }
  let envelope: WebhookEnvelope;
  try {
    envelope = source.parse(rawBody);
  } catch (err) {
    throw new GatewayError("VALIDATION_ERROR", "Webhook payload is invalid", { details: { reason: redactString(err instanceof Error ? err.message : "").slice(0, 300) } });
  }
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  let payload: unknown;
  try {
    payload = redact(JSON.parse(rawBody.toString("utf8")));
  } catch {
    payload = null;
  }
  return ctx.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(webhookEvents)
      .values({ provider: source.provider, eventType: envelope.eventType, providerEventId: envelope.eventId, payloadHash, payload, status: "received" })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    const row = inserted[0];
    if (!row) return { accepted: true, duplicate: true };
    await enqueueJob(tx, "process_webhook", { webhookEventId: row.id }, { dedupeKey: `process_webhook:${row.id}`, maxAttempts: 6, runAt: ctx.now() });
    return { accepted: true, duplicate: false, eventId: row.id };
  });
}

/** Worker job: dispatch one stored webhook to the handler that claims its kind. Idempotent; safe to retry. */
export async function processWebhookEvent(ctx: WebhookContext, webhookEventId: string): Promise<string> {
  const [row] = await ctx.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)).limit(1);
  if (!row || row.status === "processed" || row.status === "ignored") return row?.status ?? "missing";
  await ctx.db.update(webhookEvents).set({ status: "processing", attempts: row.attempts + 1, updatedAt: ctx.now() }).where(eq(webhookEvents.id, row.id));
  let envelope: WebhookEnvelope;
  try {
    envelope = ctx.webhookSource.parse(Buffer.from(JSON.stringify(row.payload)));
  } catch (err) {
    await ctx.db
      .update(webhookEvents)
      .set({ status: "failed", lastError: redactString(err instanceof Error ? err.message : String(err)).slice(0, 1000), updatedAt: ctx.now() })
      .where(eq(webhookEvents.id, row.id));
    return "failed";
  }
  try {
    const handler = ctx.webhookHandlers.find((h) => h.kinds.includes(envelope.event.kind));
    const result: WebhookHandlerResult = handler ? await handler.handle(ctx as never, envelope) : { status: "ignored" };
    await ctx.db
      .update(webhookEvents)
      .set({ status: result.status, workspaceId: result.workspaceId ?? null, processedAt: ctx.now(), lastError: null, updatedAt: ctx.now() })
      .where(eq(webhookEvents.id, row.id));
    return result.status;
  } catch (err) {
    await ctx.db
      .update(webhookEvents)
      .set({ status: "failed", lastError: redactString(err instanceof Error ? err.message : String(err)).slice(0, 1000), updatedAt: ctx.now() })
      .where(eq(webhookEvents.id, row.id));
    throw err;
  }
}

const webhookActor = (provider: string): SystemActor => ({ service: `webhook:${provider}`, requestId: "webhook" });

/** Gateway-owned handlers: account credential expiry, test and ignored events. */
export function gatewayWebhookHandlers(): WebhookEventHandler<ConnectionsContext>[] {
  return [
    {
      kinds: [GATEWAY_EVENT_KINDS.accountReauthorizationRequired],
      async handle(ctx, envelope) {
        const event = envelope.event as AccountReauthorizationEvent;
        // Ownership only through stored mappings; unknown accounts are ignored.
        const mapping = await findAccountByExternalId(ctx.db, envelope.provider, event.accountExternalId);
        if (!mapping) return { status: "ignored" };
        await ctx.db.transaction(async (tx) => {
          const changed = await markReauthorizationRequired(tx, webhookActor(envelope.provider), mapping.connection, event.reason ? redactString(event.reason) : undefined, ctx.now());
          if (changed) {
            await recordProviderEvent(tx, {
              workspaceId: mapping.connection.workspaceId,
              provider: envelope.provider,
              source: "webhook",
              type: "connection.reauthorization_required",
              resourceType: "connection",
              resourceId: mapping.connection.id,
              occurredAt: envelope.occurredAt,
            });
          }
        });
        return { status: "processed", workspaceId: mapping.connection.workspaceId };
      },
    },
    { kinds: [GATEWAY_EVENT_KINDS.test], handle: async () => ({ status: "processed" }) },
    { kinds: [GATEWAY_EVENT_KINDS.ignored], handle: async () => ({ status: "ignored" }) },
  ];
}
