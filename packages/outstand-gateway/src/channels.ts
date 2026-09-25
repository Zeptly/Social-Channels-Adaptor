import type { ChannelDescriptor } from "@zeptly-gateway/gateway-core";
import { OUTSTAND_SOCIAL_NETWORKS } from "@zeptly-gateway/social-publishing/outstand";

/**
 * Account channels the Outstand gateway can provision. For Outstand every
 * channel is a social network; connection strategies are Outstand facts
 * (Managed-Key OAuth, and Bluesky's provider-managed / app-password flow).
 */
const STRATEGIES: Record<string, Pick<ChannelDescriptor, "connectionStrategy" | "supportedStrategies">> = {
  bluesky: { connectionStrategy: "provider_managed", supportedStrategies: ["provider_managed", "credentials"] },
};

export const OUTSTAND_CHANNELS: ChannelDescriptor[] = Object.values(OUTSTAND_SOCIAL_NETWORKS).map((d) => ({
  channel: d.network,
  displayName: d.displayName,
  ...(STRATEGIES[d.network] ?? { connectionStrategy: "oauth_redirect", supportedStrategies: ["oauth_redirect"] }),
  notes: [...d.notes],
}));
