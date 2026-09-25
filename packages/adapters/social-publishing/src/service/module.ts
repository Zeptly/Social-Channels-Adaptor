import { socialMedia } from "@zeptly-gateway/database";
import { type CapabilityModule, str } from "@zeptly-gateway/gateway-core";
import { and, eq, lt } from "drizzle-orm";
import { SOCIAL_PUBLISHING_CONTRACT, SOCIAL_SCHEDULING_CONTRACT } from "../contract/index.js";
import type { SocialPublishingContext } from "./context.js";
import { runHandoff } from "./dispatch.js";
import { processMediaUpload } from "./media.js";
import { enqueueDueReconciliations, reconcilePublication } from "./reconcile.js";
import { publicationOutcomeHandler } from "./webhook-handler.js";

export const HANDOFF_TICK_MS = 60_000;

async function expireAbandonedUploads(ctx: SocialPublishingContext): Promise<void> {
  const now = ctx.now();
  await ctx.db
    .update(socialMedia)
    .set({ status: "failed", error: "Upload was never completed", updatedAt: now })
    .where(and(eq(socialMedia.status, "pending_upload"), lt(socialMedia.createdAt, new Date(now.getTime() - 86_400_000))));
}

/**
 * Social Publishing capability (Social Publishing Contract v1): media, posts,
 * targets, publications, reconciliation and the durable hand-off tick.
 */
export function socialPublishingModule(ctxChannels: () => string[]): CapabilityModule<SocialPublishingContext> {
  return {
    descriptor: { ...SOCIAL_PUBLISHING_CONTRACT, title: "Social publishing", description: "Publish posts with media to connected social network accounts." },
    channels: ctxChannels,
    jobs: {
      upload_media: (ctx, p) => processMediaUpload(ctx, str(p, "mediaId")),
      reconcile_publication: (ctx, p) => reconcilePublication(ctx, str(p, "publicationId")),
      reconcile_publications: (ctx) => enqueueDueReconciliations(ctx),
    },
    periodic: [{ type: "reconcile_publications", everyMs: 5 * 60_000 }],
    ticks: [{ name: "handoff", everyMs: HANDOFF_TICK_MS, run: async (ctx, workerId) => (await runHandoff(ctx, workerId, { limit: 50 })).length }],
    webhookHandlers: [publicationOutcomeHandler],
    housekeeping: expireAbandonedUploads,
  };
}

/**
 * Social Scheduling capability: provider-independent canonical schedules with
 * rolling hand-off inside the provider's scheduling horizon. Its runtime work
 * is carried by the publishing module; this descriptor makes it discoverable.
 */
export function socialSchedulingModule(ctxChannels: () => string[]): CapabilityModule<SocialPublishingContext> {
  return {
    descriptor: { ...SOCIAL_SCHEDULING_CONTRACT, title: "Social scheduling", description: "Schedule posts for future publication, including beyond the provider's scheduling horizon." },
    channels: ctxChannels,
  };
}
