/** What a gateway's provider adapter provides for Social Analytics. */
export interface RemotePostMetrics {
  accountExternalId: string;
  metrics: Array<{ name: string; value: number }>;
}

export interface SocialAnalyticsPort {
  readonly provider: string;
  /** Metrics per provider account for one provider post. */
  getPostMetrics(providerPostId: string): Promise<RemotePostMetrics[]>;
}
