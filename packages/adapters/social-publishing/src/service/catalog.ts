import { GatewayError } from "@zeptly-gateway/gateway-contract";
import { NETWORK_FEATURES, type NetworkDescriptor, type NetworkFeature, type SocialCapabilities } from "../contract/capabilities.js";
import { SOCIAL_NETWORKS, type SocialNetwork } from "../contract/networks.js";

/**
 * Network catalog: which social networks this gateway serves for Social
 * Publishing, with verified per-network features and constraints. Replaces the
 * former cross-provider capability router — the provider is fixed by the gateway.
 */
export class NetworkCatalog {
  private readonly byNetwork: Partial<Record<SocialNetwork, NetworkDescriptor>>;

  constructor(descriptors: Partial<Record<SocialNetwork, NetworkDescriptor>>) {
    this.byNetwork = descriptors;
  }

  networks(): NetworkDescriptor[] {
    return SOCIAL_NETWORKS.map((n) => this.byNetwork[n]).filter((d): d is NetworkDescriptor => d !== undefined);
  }

  describe(network: string): NetworkDescriptor | undefined {
    return this.byNetwork[network as SocialNetwork];
  }

  features(network: string): SocialCapabilities {
    const d = this.describe(network);
    if (d) return { ...d.capabilities };
    return Object.fromEntries(NETWORK_FEATURES.map((f) => [f, false])) as SocialCapabilities;
  }

  supports(network: string, feature: NetworkFeature): boolean {
    return this.features(network)[feature];
  }

  /** Networks on which a feature is offered. */
  networksWith(feature: NetworkFeature): SocialNetwork[] {
    return this.networks()
      .filter((d) => d.capabilities[feature])
      .map((d) => d.network);
  }

  /** Throws CAPABILITY_NOT_SUPPORTED unless the gateway offers the feature on the network. */
  assert(network: string, feature: NetworkFeature): void {
    if (!this.supports(network, feature)) {
      throw new GatewayError("CAPABILITY_NOT_SUPPORTED", `The ${feature} capability is not supported for ${network}`, { details: { network, capability: feature } });
    }
  }
}
