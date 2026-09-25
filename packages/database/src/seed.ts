/**
 * Local development seed (idempotent): a test workspace with mock connections,
 * posts and publication history, so the API can be explored without Outstand.
 *
 *   pnpm db:migrate && pnpm db:seed
 *
 * Seeded provider account ids (seed_*) do not exist at any provider; to publish
 * locally, connect an account through the mock Outstand flow (see README).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "./client.js";
import {
  auditEvents,
  providerAccounts,
  gatewayConnections,
  socialMetrics,
  socialPosts,
  socialPostTargets,
  socialPublications,
  socialSchedules,
  workspaces,
} from "./schema.js";

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}
const WORKSPACE = process.env.SEED_WORKSPACE ?? "ws_local_test";
const handle = createDatabase(url, { max: 2 });
const db = handle.db;

const existing = await db.select().from(workspaces).where(eq(workspaces.externalId, WORKSPACE));
if (existing[0]) {
  process.stdout.write(`seed: workspace ${WORKSPACE} already exists; nothing to do\n`);
  await handle.close();
  process.exit(0);
}

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
await db.transaction(async (tx) => {
  const [ws] = await tx.insert(workspaces).values({ externalId: WORKSPACE, providerTenantRef: `zs_${randomBytes(16).toString("hex")}` }).returning();
  if (!ws) throw new Error("workspace insert failed");
  const mk = async (network: string, username: string, status = "connected") => {
    const [c] = await tx
      .insert(gatewayConnections)
      .values({ workspaceId: ws.id, network, provider: "outstand", status, displayName: username, username, accountType: "organization", connectedAt: hoursAgo(72), lastCheckedAt: hoursAgo(1) })
      .returning();
    if (!c) throw new Error("connection insert failed");
    await tx.insert(providerAccounts).values({ workspaceId: ws.id, connectionId: c.id, provider: "outstand", externalId: `seed_${network}_${randomBytes(3).toString("hex")}`, network });
    return c;
  };
  const li = await mk("linkedin", "acme-inc");
  const ig = await mk("instagram", "acme.gram");
  await mk("facebook", "Acme Page", "reauthorization_required");

  // A published post with history + metrics.
  const [published] = await tx
    .insert(socialPosts)
    .values({ workspaceId: ws.id, status: "published", content: { text: "We just launched our new product line!" }, idempotencyKey: "seed-published", requestHash: "seed", createdBy: "seed" })
    .returning();
  if (!published) throw new Error("post insert failed");
  const [pub] = await tx
    .insert(socialPublications)
    .values({
      workspaceId: ws.id,
      postId: published.id,
      provider: "outstand",
      network: "linkedin",
      snapshot: { text: "We just launched our new product line!", mediaIds: [], options: {} },
      mode: "immediate",
      status: "published",
      publishAt: hoursAgo(24),
      attempts: 1,
      providerPostId: `seed_post_${randomBytes(3).toString("hex")}`,
      handedOffAt: hoursAgo(24),
      lastReconciledAt: hoursAgo(23),
    })
    .returning();
  const [t] = await tx
    .insert(socialPostTargets)
    .values({ workspaceId: ws.id, postId: published.id, connectionId: li.id, publicationId: pub?.id, network: "linkedin", status: "published", platformPostId: "urn:li:share:seed", platformPostUrl: "https://www.linkedin.com/feed/update/urn:li:share:seed", publishedAt: hoursAgo(24) })
    .returning();
  for (const [metric, value] of [["likes", 42], ["comments", 7], ["shares", 3], ["reach", 1200]] as const) {
    await tx.insert(socialMetrics).values({ workspaceId: ws.id, connectionId: li.id, postId: published.id, targetId: t?.id, network: "linkedin", metric, value, provider: "outstand", measuredAt: hoursAgo(2) });
  }

  // A long-range scheduled post (beyond the Outstand horizon) awaiting hand-off.
  const at = new Date(now.getTime() + 60 * 86_400_000);
  const [scheduled] = await tx
    .insert(socialPosts)
    .values({ workspaceId: ws.id, status: "scheduled", scheduledAt: at, timezone: "Europe/London", content: { text: "Quarterly update (scheduled)" }, idempotencyKey: "seed-scheduled", requestHash: "seed", createdBy: "seed" })
    .returning();
  if (!scheduled) throw new Error("post insert failed");
  const [spub] = await tx
    .insert(socialPublications)
    .values({ workspaceId: ws.id, postId: scheduled.id, provider: "outstand", network: "linkedin", snapshot: { text: "Quarterly update (scheduled)", mediaIds: [], options: {} }, mode: "scheduled", status: "pending", publishAt: at })
    .returning();
  await tx.insert(socialPostTargets).values({ workspaceId: ws.id, postId: scheduled.id, connectionId: li.id, publicationId: spub?.id, network: "linkedin", status: "scheduled" });
  await tx.insert(socialSchedules).values({ workspaceId: ws.id, postId: scheduled.id, scheduledAt: at, timezone: "Europe/London", status: "active" });

  // A draft for Instagram.
  await tx.insert(socialPosts).values({ workspaceId: ws.id, status: "draft", content: { text: "Draft caption" }, idempotencyKey: "seed-draft", requestHash: "seed", createdBy: "seed" });
  void ig;
  await tx.insert(auditEvents).values({ workspaceId: ws.id, action: "seed.created", actorService: "seed", metadata: {} });
});
process.stdout.write(`seed: created workspace ${WORKSPACE} with connections, posts and publication history\n`);
await handle.close();
