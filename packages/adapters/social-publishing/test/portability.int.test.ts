/**
 * Architecture test B: Social Publishing Contract v1 is implementable by a
 * gateway other than Outstand. The canonical service runs here against an
 * in-memory port for an imaginary provider ("acme") and its own network
 * catalog — no Outstand package is imported, and the canonical objects are
 * unchanged.
 */
import { gatewayConnections, providerAccounts } from "@zeptly-gateway/database";
import { type Actor, ensureWorkspace } from "@zeptly-gateway/gateway-core";
import { openTestDatabase, resetDatabase, silentLogger, TestClock } from "@zeptly-gateway/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NetworkCatalog,
  type NetworkDescriptor,
  posts,
  type PublishRequest,
  type RemotePostState,
  SocialPostSchema,
  type SocialPublishingContext,
  type SocialPublishingPort,
} from "../src/index.js";

class InMemoryPort implements SocialPublishingPort {
  readonly provider = "acme";
  readonly schedulingHorizonMs = undefined;
  readonly supportsPostUpdate = false;
  readonly published: PublishRequest[] = [];
  private readonly store = new Map<string, RemotePostState>();

  async prepareUpload(): Promise<never> {
    throw new Error("not used");
  }
  async confirmUpload(): Promise<never> {
    throw new Error("not used");
  }
  async uploadFromUrl(): Promise<never> {
    throw new Error("not used");
  }
  async publish(input: PublishRequest): Promise<RemotePostState> {
    this.published.push(input);
    const state: RemotePostState = {
      externalId: `acme_post_${this.published.length}`,
      targets: input.accountExternalIds.map((a) => ({ accountExternalId: a, status: "published", platformPostId: `pp_${this.published.length}`, platformPostUrl: `https://acme.example/p/${this.published.length}` })),
    };
    this.store.set(state.externalId, state);
    return state;
  }
  async schedule(input: PublishRequest & { scheduledAt: Date }): Promise<RemotePostState> {
    return this.publish(input);
  }
  async getPost(externalId: string): Promise<RemotePostState> {
    const s = this.store.get(externalId);
    if (!s) throw new Error("unknown");
    return s;
  }
  async deletePost(externalId: string): Promise<void> {
    this.store.delete(externalId);
  }
}

const mastodonLike: NetworkDescriptor = {
  network: "threads",
  displayName: "Threads (via Acme)",
  capabilities: { connect: true, publish: true, schedule: true, media: false, analytics: false, comments: false, conversations: false, directMessages: false, delete: true, firstComment: false },
  constraints: { maxTextLength: 280, textRequired: true, mediaRequired: false, maxMediaItems: 0, allowMixedMedia: false, options: [] },
  notes: [],
};

describe("architecture B: Social Publishing on a non-Outstand gateway", () => {
  let db: Awaited<ReturnType<typeof openTestDatabase>>;
  beforeAll(async () => {
    db = await openTestDatabase();
    await resetDatabase(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("creates and publishes a canonical post through another provider's port", async () => {
    const clock = new TestClock(Date.parse("2026-09-24T10:00:00Z"));
    const port = new InMemoryPort();
    const ctx: SocialPublishingContext = {
      gatewayId: "acme",
      db: db.db,
      logger: silentLogger(),
      settings: { publicBaseUrl: "https://acme-gateway.example", allowedReturnOrigins: [] },
      now: clock.now,
      publishing: port,
      socialCatalog: new NetworkCatalog({ threads: mastodonLike }),
      publishingSettings: { handoffMarginMs: 0, inlineDispatch: true, skipMediaDnsCheck: true },
    };
    const workspace = await ensureWorkspace(db.db, "ws_acme");
    const [conn] = await db.db
      .insert(gatewayConnections)
      .values({ workspaceId: workspace.id, network: "threads", provider: "acme", status: "connected", displayName: "Acme account" })
      .returning();
    if (!conn) throw new Error("insert failed");
    await db.db.insert(providerAccounts).values({ workspaceId: workspace.id, connectionId: conn.id, provider: "acme", externalId: "acme_acct_1", network: "threads" });
    const actor: Actor = { workspace, service: "test", requestId: "req-b" };

    const { post } = await posts.createPost(ctx, actor, { content: { text: "hello from another gateway" }, targets: [{ connectionId: conn.id }] }, "idem-portability-1");
    const published = await posts.publishPost(ctx, actor, post.id);

    expect(port.published).toHaveLength(1);
    expect(port.published[0]).toMatchObject({ network: "threads", accountExternalIds: ["acme_acct_1"], text: "hello from another gateway" });
    expect(published.status).toBe("published");
    expect(published.targets[0]).toMatchObject({ status: "published", platformPostUrl: "https://acme.example/p/1" });
    // Same canonical contract object, no provider identifiers.
    expect(SocialPostSchema.safeParse(published).success).toBe(true);
    expect(JSON.stringify(published)).not.toMatch(/acme_acct_1"|acme_post_/);

    // The other gateway's catalog is authoritative: unsupported networks are rejected canonically.
    await expect(posts.createPost({ ...ctx, socialCatalog: new NetworkCatalog({}) }, actor, { content: { text: "x" }, targets: [{ connectionId: conn.id }] }, "idem-portability-2")).rejects.toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });
  });
});
