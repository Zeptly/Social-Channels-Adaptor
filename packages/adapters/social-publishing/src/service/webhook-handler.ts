import { type Executor, socialPostTargets, socialPublications } from "@zeptly-gateway/database";
import type { WebhookEnvelope } from "@zeptly-gateway/gateway-contract";
import { findAccountByExternalId, recordAudit, type SystemActor, type WebhookEventHandler } from "@zeptly-gateway/gateway-core";
import { redactString } from "@zeptly-gateway/observability";
import { and, eq, inArray } from "drizzle-orm";
import { PUBLICATION_OUTCOME_EVENT, type PublicationOutcomeEvent } from "../port.js";
import type { SocialPublishingContext } from "./context.js";
import { recomputePostStatus } from "./dispatch.js";
import { reconcilePublication } from "./reconcile.js";

/** Handles normalized publication outcome events (provider post webhooks). */
export const publicationOutcomeHandler: WebhookEventHandler<SocialPublishingContext> = {
  kinds: [PUBLICATION_OUTCOME_EVENT],
  async handle(ctx, envelope) {
    const event = envelope.event as PublicationOutcomeEvent;
    // Amplification protection: only posts this gateway created are touched.
    const [pub] = await ctx.db
      .select()
      .from(socialPublications)
      .where(and(eq(socialPublications.provider, envelope.provider), eq(socialPublications.providerPostId, event.providerPostId)))
      .limit(1);
    if (!pub) return { status: "ignored" };
    await applyPostFacts(ctx.db, pub.id, pub.workspaceId, pub.postId, envelope as WebhookEnvelope<PublicationOutcomeEvent>);
    // Webhooks are immediate facts; the provider's GET is authoritative for every target.
    await reconcilePublication(ctx, pub.id, "webhook");
    return { status: "processed", workspaceId: pub.workspaceId };
  },
};

/**
 * Apply per-account facts stated by a post webhook to the listed targets only.
 * Account ids are resolved through the publication's own targets (same
 * workspace); unlisted targets are not inferred either way.
 */
async function applyPostFacts(db: Executor, publicationId: string, workspaceId: string, postId: string, envelope: WebhookEnvelope<PublicationOutcomeEvent>): Promise<number> {
  const { provider, event } = envelope;
  const actor: SystemActor = { service: `webhook:${provider}`, requestId: "webhook" };
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
            publishedAt: t.publishedAt ?? envelope.occurredAt,
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
