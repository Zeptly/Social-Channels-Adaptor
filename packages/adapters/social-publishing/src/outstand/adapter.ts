import type { OutstandClient, OutstandMedia, OutstandPostState } from "@zeptly-gateway/outstand-client";
import type { PreparedUpload, PublishRequest, RemoteMedia, RemotePostState, SocialPublishingPort, UpdateRequest } from "../port.js";

/**
 * Outstand implementation of the Social Publishing port. Translates between
 * the provider-neutral port types and the Outstand client's typed results;
 * Outstand transport, auth, wire shapes and error mapping stay inside
 * @zeptly-gateway/outstand-client.
 */
export class OutstandSocialPublishingAdapter implements SocialPublishingPort {
  readonly provider: string;
  readonly schedulingHorizonMs: number | undefined;
  readonly supportsPostUpdate: boolean;

  constructor(private readonly client: OutstandClient) {
    this.provider = client.provider;
    this.schedulingHorizonMs = client.schedulingHorizonMs;
    this.supportsPostUpdate = client.supportsPostUpdate;
  }

  async prepareUpload(input: { filename: string; contentType: string }): Promise<PreparedUpload> {
    const p = await this.client.prepareUpload(input);
    return { externalId: p.externalId, uploadUrl: p.uploadUrl, expiresAt: p.expiresAt };
  }

  async confirmUpload(input: { externalId: string; filename: string; sizeBytes?: number }): Promise<RemoteMedia> {
    return toRemoteMedia(await this.client.confirmUpload(input));
  }

  async uploadFromUrl(input: { sourceUrl: string; filename: string; contentType: string; maxBytes: number }): Promise<RemoteMedia> {
    return toRemoteMedia(await this.client.uploadFromUrl(input));
  }

  async publish(input: PublishRequest): Promise<RemotePostState> {
    return toRemotePost(await this.client.publish({ ...input, media: input.media.map(toOutstandMedia) }));
  }

  async schedule(input: PublishRequest & { scheduledAt: Date }): Promise<RemotePostState> {
    return toRemotePost(await this.client.schedule({ ...input, media: input.media.map(toOutstandMedia) }));
  }

  async getPost(externalId: string): Promise<RemotePostState> {
    return toRemotePost(await this.client.getPost(externalId));
  }

  deletePost(externalId: string): Promise<void> {
    return this.client.deletePost(externalId);
  }

  async updatePost(externalId: string, input: UpdateRequest): Promise<RemotePostState> {
    return toRemotePost(await this.client.updatePost(externalId, { ...input, media: input.media.map(toOutstandMedia) }));
  }
}

const toRemoteMedia = (m: OutstandMedia): RemoteMedia => ({
  externalId: m.externalId,
  url: m.url,
  filename: m.filename,
  ...(m.contentType ? { contentType: m.contentType } : {}),
  ...(m.sizeBytes !== undefined ? { sizeBytes: m.sizeBytes } : {}),
  ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
});

const toOutstandMedia = (m: RemoteMedia): OutstandMedia => ({ ...m });

const toRemotePost = (p: OutstandPostState): RemotePostState => ({
  externalId: p.externalId,
  ...(p.scheduledAt ? { scheduledAt: p.scheduledAt } : {}),
  ...(p.publishedAt ? { publishedAt: p.publishedAt } : {}),
  targets: p.targets.map((t) => ({
    accountExternalId: t.accountExternalId,
    status: t.status,
    ...(t.platformPostId ? { platformPostId: t.platformPostId } : {}),
    ...(t.platformPostUrl ? { platformPostUrl: t.platformPostUrl } : {}),
    ...(t.error ? { error: t.error } : {}),
    ...(t.publishedAt ? { publishedAt: t.publishedAt } : {}),
  })),
});
