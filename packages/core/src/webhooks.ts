import { createHash } from "node:crypto";
import { SocialError } from "@zeptly-social/domain";
import { type Executor, socialPostTargets, socialPublications, webhookEvents, type WebhookEventRow } from "@zeptly-social/database";
import { type ProviderEvent, ProviderError } from "@zeptly-social/provider-contract";
import { redact, redactString } from "@zeptly-social/observability";
import { and, eq, inArray } from "drizzle-orm";
import { recordAudit, recordProviderEvent } from "./audit.js";
import { markReauthorizationRequired } from "./connections.js";
import type { ServiceContext, SystemActor } from "./context.js";
import { recomputePostStatus } from "./dispatch.js";
import { upsertConversationFromProvider } from "./conversations.js";
import { enqueueJob } from "./jobs.js";
import { reconcilePublication } from "./reconcile.js";
import { findAccountByExternalId } from "./tenancy.js";

export interface WebhookReceipt {
  accepted: boolean;
  duplicate: boolean;
  eventId?: string;
}

/**
 * POST /v1/webhooks/:provider. Order: verify signature over the RAW bytes →
 * parse → deduplicate → persist receipt + enqueue processing (one transaction)
 * → 2xx. Nothing is persisted for an invalid signature, and no
 * webhook-controlled identifier is read before authentication.
 */
export async function receiveWebhook(ctx: ServiceContext, providerName: string, rawBody: Buffer, signature: string | undefined): Promise<WebhookReceipt> {
  if (!ctx.providers.has(providerName)) throw new SocialError("NOT_FOUND", "Unknown webhook provider");
  const provider = ctx.providers.get(providerName);
  const check = provider.webhooks.verify(rawBody, signature);
  if (check !== "valid") {
    ctx.logger.warn({ provider: providerName, signature: check }, "webhook rejected: signature");
    throw new SocialError("WEBHOOK_SIGNATURE_INVALID", "Webhook signature verification failed");
  }
  let parsed;
  try {
    parsed = provider.webhooks.parse(rawBody);
  } catch (err) {
    throw new SocialError("VALIDATION_ERROR", "Webhook payload is invalid", { details: { reason: redactString(err instanceof Error ? err.message : "").slice(0, 300) } });
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
      .values({ provider: providerName, eventType: parsed.type, providerEventId: parsed.eventId, payloadHash, payload, status: "received" })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    const row = inserted[0];
    if (!row) return { accepted: true, duplicate: true };
    await enqueueJob(tx, "process_webhook", { webhookEventId: row.id }, { dedupeKey: `process_webhook:${row.id}`, maxAttempts: 6, runAt: ctx.now() });
    return { accepted: true, duplicate: false, eventId: row.id };
  });
}

const actor: SystemActor = { service: "webhook:outstand", requestId: "webhook" };

/** Worker job: apply one stored webhook. Idempotent; safe to retry. */
export async function processWebhookEvent(ctx: ServiceContext, webhookEventId: string): Promise<string> {
  const [row] = await ctx.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)).limit(1);
  if (!row || row.status === "processed" || row.status === "ignored") return row?.status ?? "missing";
  await ctx.db.update(webhookEvents).set({ status: "processing", attempts: row.attempts + 1, updatedAt: ctx.now() }).where(eq(webhookEvents.id, row.id));
  try {
    const provider = ctx.providers.get(row.provider);
    const parsed = provider.webhooks.parse(Buffer.from(JSON.stringify(row.payload)));
    const { status, workspaceId } = await applyEvent(ctx, row, parsed.event);
    await ctx.db
      .update(webhookEvents)
      .set({ status, workspaceId: workspaceId ?? null, processedAt: ctx.now(), lastError: null, updatedAt: ctx.now() })
      .where(eq(webhookEvents.id, row.id));
    return status;
  } catch (err) {
    const permanent = err instanceof ProviderError && err.kind === "protocol";
    await ctx.db
      .update(webhookEvents)
      .set({ status: "failed", lastError: redactString(err instanceof Error ? err.message : String(err)).slice(0, 1000), updatedAt: ctx.now() })
      .where(eq(webhookEvents.id, row.id));
    if (permanent) return "failed";
    throw err;
  }
}

async function applyEvent(ctx: ServiceContext, row: WebhookEventRow, event: ProviderEvent): Promise<{ status: "processed" | "ignored"; workspaceId?: string }> {
  switch (event.kind) {
    case "post_outcome": {
      // Amplification protection: only posts this service created are touched.
      const [pub] = await ctx.db
        .select()
        .from(socialPublications)
        .where(and(eq(socialPublications.provider, row.provider), eq(socialPublications.providerPostId, event.providerPostId)))
        .limit(1);
      if (!pub) return { status: "ignored" };
      await applyPostFacts(ctx.db, pub.id, pub.workspaceId, pub.postId, row.provider, event);
      // Webhooks are immediate facts; the provider's GET is authoritative for every target.
      await reconcilePublication(ctx, pub.id, "webhook");
      return { status: "processed", workspaceId: pub.workspaceId };
    }
    case "account_reauthorization_required": {
      const mapping = await findAccountByExternalId(ctx.db, row.provider, event.accountExternalId);
      if (!mapping) return { status: "ignored" };
      await ctx.db.transaction(async (tx) => {
        const changed = await markReauthorizationRequired(tx, actor, mapping.connection, event.reason ? redactString(event.reason) : undefined, ctx.now());
        if (changed) {
          await recordProviderEvent(tx, {
            workspaceId: mapping.connection.workspaceId,
            provider: row.provider,
            source: "webhook",
            type: "connection.reauthorization_required",
            resourceType: "connection",
            resourceId: mapping.connection.id,
            occurredAt: event.occurredAt,
          });
        }
      });
      return { status: "processed", workspaceId: mapping.connection.workspaceId };
    }
    case "conversation_message": {
      const mapping = await findAccountByExternalId(ctx.db, row.provider, event.accountExternalId);
      if (!mapping) return { status: "ignored" };
      if (!ctx.router.supports(mapping.connection.provider, mapping.connection.network as never, "conversations")) return { status: "ignored" };
      await upsertConversationFromProvider(ctx, mapping, event.conversation, event.message ? [event.message] : []);
      return { status: "processed", workspaceId: mapping.connection.workspaceId };
    }
    case "test":
      return { status: "processed" };
    case "ignored":
      return { status: "ignored" };
  }
}

/**
 * Apply per-account facts stated by a post webhook to the listed targets only.
 * Account ids are resolved through the publication's own targets (same
 * workspace); unlisted targets are not inferred either way.
 */
async function applyPostFacts(
  db: Executor,
  publicationId: string,
  workspaceId: string,
  postId: string,
  provider: string,
  event: Extract<ProviderEvent, { kind: "post_outcome" }>,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [pubRow] = await tx.select().from(socialPublications).where(eq(socialPublications.id, publicationId)).for("update");
    if (!pubRow || pubRow.status === "cancelled") return 0;
    const targets = await tx.select().from(socialPostTargets).where(and(eq(socialPostTargets.publicationId, publicationId), eq(socialPostTargets.workspaceId, workspaceId)));
    let changed = 0;
    for (const fact of event.accounts) {
      const mapping = await findAccountByExternalId(tx, provider, fact.accountExternalId);
      if (!mapping || mapping.connection.workspaceId !== workspaceId) continue;
      const t = targets.find((x) => x.connectionId === mapping.connection.id);
      if (!t || t.status === "cancelled") continue;
      if (fact.outcome === "published") {
        if (t.status === "published" && (t.platformPostId || !fact.platformPostId)) continue;
        await tx
          .update(socialPostTargets)
          .set({
            status: "published",
            platformPostId: fact.platformPostId ?? t.platformPostId,
            platformPostUrl: fact.platformPostUrl ?? t.platformPostUrl,
            publishedAt: t.publishedAt ?? event.occurredAt,
            errorCode: null,
            errorMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(socialPostTargets.id, t.id));
        changed++;
      } else {
        if (t.status === "published" || t.status === "failed") continue;
        await tx
          .update(socialPostTargets)
          .set({ status: "failed", errorCode: "PUBLICATION_FAILED", errorMessage: redactString(fact.error ?? "Publishing failed on the network").slice(0, 1000), updatedAt: new Date() })
          .where(eq(socialPostTargets.id, t.id));
        changed++;
      }
    }
    if (changed > 0) {
      const all = await tx.select({ status: socialPostTargets.status }).from(socialPostTargets).where(inArray(socialPostTargets.id, targets.map((t) => t.id)));
      const open = all.some((s) => s.status === "pending" || s.status === "scheduled" || s.status === "publishing");
      if (!open) {
        const published = all.filter((s) => s.status === "published").length;
        const status = published === all.length ? "published" : published > 0 ? "partially_published" : "failed";
        await tx.update(socialPublications).set({ status, updatedAt: new Date() }).where(eq(socialPublications.id, publicationId));
      }
      await recomputePostStatus(tx, postId, workspaceId, actor);
      await recordAudit(tx, actor, { workspaceId, action: "publication.webhook_facts", resourceType: "publication", resourceId: publicationId, metadata: { changed } });
    }
    return changed;
  });
}
