import type { OutstandClient } from "@zeptly-gateway/outstand-client";
import type { RemotePostMetrics, SocialAnalyticsPort } from "../port.js";

/** Outstand implementation of the Social Analytics port. */
export class OutstandSocialAnalyticsAdapter implements SocialAnalyticsPort {
  readonly provider: string;

  constructor(private readonly client: OutstandClient) {
    this.provider = client.provider;
  }

  async getPostMetrics(providerPostId: string): Promise<RemotePostMetrics[]> {
    const results = await this.client.getMetrics(providerPostId);
    return results.map((r) => ({ accountExternalId: r.accountExternalId, metrics: r.metrics.map((m) => ({ name: m.name, value: m.value })) }));
  }
}
