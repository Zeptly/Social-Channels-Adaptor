import {
  type Capability,
  type NetworkDescriptor,
  type ProviderName,
  SOCIAL_NETWORKS,
  type SocialCapabilities,
  SocialError,
  type SocialNetwork,
  isSocialNetwork,
} from "@zeptly-social/domain";
import { OUTSTAND_NETWORKS, OUTSTAND_REGISTRY_VERSION } from "./outstand-v1.js";

export { OUTSTAND_NETWORKS, OUTSTAND_REGISTRY_VERSION };

/** Per-provider registry: which networks a provider serves, and with which capabilities. */
export interface ProviderCapabilityTable {
  provider: ProviderName;
  version: string;
  networks: Partial<Record<SocialNetwork, NetworkDescriptor>>;
}

export const OUTSTAND_TABLE: ProviderCapabilityTable = {
  provider: "outstand",
  version: OUTSTAND_REGISTRY_VERSION,
  networks: OUTSTAND_NETWORKS,
};

export interface RouteRequest {
  capability: Capability;
  network: SocialNetwork;
  /** Reserved for per-workspace provider overrides (e.g. a workspace piloting Zernio analytics). */
  workspaceId?: string;
}

/**
 * Capability router: (capability + network + workspace) → provider.
 *
 * V1 has one provider table (Outstand). Future providers register their own
 * table; resolution order is the table order (first provider that supports the
 * capability for the network wins), optionally overridden per workspace. The
 * public API never changes because callers only ever see canonical objects.
 */
export class CapabilityRouter {
  private readonly tables: ProviderCapabilityTable[];
  private readonly workspaceOverrides: Map<string, ProviderName[]>;

  constructor(tables: ProviderCapabilityTable[] = [OUTSTAND_TABLE], workspaceOverrides: Map<string, ProviderName[]> = new Map()) {
    if (tables.length === 0) throw new Error("CapabilityRouter needs at least one provider table");
    this.tables = tables;
    this.workspaceOverrides = workspaceOverrides;
  }

  /** Networks exposed by at least one provider. */
  networks(): NetworkDescriptor[] {
    return SOCIAL_NETWORKS.map((n) => this.describe(n)).filter((d): d is NetworkDescriptor => d !== undefined);
  }

  /** Effective descriptor for a network (primary provider's descriptor with capabilities merged across providers). */
  describe(network: SocialNetwork): NetworkDescriptor | undefined {
    const descriptors = this.tables.map((t) => t.networks[network]).filter((d): d is NetworkDescriptor => d !== undefined);
    const [primary] = descriptors;
    if (!primary) return undefined;
    return { ...primary, capabilities: this.capabilities(network) };
  }

  capabilities(network: SocialNetwork): SocialCapabilities {
    const out = { ...emptyCapabilities() };
    for (const t of this.tables) {
      const d = t.networks[network];
      if (!d) continue;
      for (const k of Object.keys(out) as Capability[]) out[k] = out[k] || d.capabilities[k];
    }
    return out;
  }

  /** Capabilities of a specific provider for a network (what a connection served by that provider can do). */
  providerCapabilities(provider: string, network: SocialNetwork): SocialCapabilities {
    const t = this.tables.find((x) => x.provider === provider);
    return t?.networks[network]?.capabilities ?? emptyCapabilities();
  }

  supports(provider: string, network: SocialNetwork, capability: Capability): boolean {
    return this.providerCapabilities(provider, network)[capability];
  }

  resolve(req: RouteRequest): ProviderName {
    if (!isSocialNetwork(req.network)) {
      throw new SocialError("NETWORK_NOT_SUPPORTED", `Network is not supported`, { details: { network: req.network } });
    }
    const order = this.order(req.workspaceId);
    for (const provider of order) {
      const t = this.tables.find((x) => x.provider === provider);
      if (t?.networks[req.network]?.capabilities[req.capability]) return t.provider;
    }
    throw capabilityError(req.network, req.capability);
  }

  /** Throws CAPABILITY_NOT_SUPPORTED unless `provider` supports the capability for the network. */
  assert(provider: string, network: SocialNetwork, capability: Capability): void {
    if (!this.supports(provider, network, capability)) throw capabilityError(network, capability);
  }

  private order(workspaceId?: string): ProviderName[] {
    const override = workspaceId ? this.workspaceOverrides.get(workspaceId) : undefined;
    const base = this.tables.map((t) => t.provider);
    return override ? [...override, ...base.filter((p) => !override.includes(p))] : base;
  }
}

export function capabilityError(network: SocialNetwork, capability: Capability): SocialError {
  return new SocialError("CAPABILITY_NOT_SUPPORTED", `The ${capability} capability is not supported for ${network}`, {
    details: { network, capability },
  });
}

export function emptyCapabilities(): SocialCapabilities {
  return {
    connect: false,
    publish: false,
    schedule: false,
    media: false,
    analytics: false,
    comments: false,
    conversations: false,
    directMessages: false,
    delete: false,
    firstComment: false,
  };
}
