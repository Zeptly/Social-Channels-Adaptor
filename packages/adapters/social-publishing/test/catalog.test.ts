import { describe, expect, it } from "vitest";
import { type NetworkDescriptor, NetworkCatalog, SOCIAL_NETWORKS, SocialNetworkSchema } from "../src/index.js";
import { OUTSTAND_SOCIAL_NETWORKS } from "../src/outstand/index.js";

describe("V1 network boundary", () => {
  it("exposes exactly the Outstand Managed-Key networks", () => {
    expect(Object.keys(OUTSTAND_SOCIAL_NETWORKS).sort()).toEqual([...SOCIAL_NETWORKS].sort());
    expect(SOCIAL_NETWORKS).toHaveLength(8);
  });

  it.each(["x", "twitter", "reddit", "google_business", "vimeo"])("rejects BYOK network %s at the contract", (network) => {
    expect(SocialNetworkSchema.safeParse(network).success).toBe(false);
  });
});

describe("network catalog (no provider routing)", () => {
  const catalog = new NetworkCatalog(OUTSTAND_SOCIAL_NETWORKS);

  it("offers publishing on every network", () => {
    expect(catalog.networksWith("publish").sort()).toEqual([...SOCIAL_NETWORKS].sort());
  });

  it("advertises conversations only where verified (Instagram DMs)", () => {
    for (const n of SOCIAL_NETWORKS) {
      expect(catalog.features(n).conversations).toBe(n === "instagram");
      expect(catalog.features(n).directMessages).toBe(n === "instagram");
    }
    expect(() => catalog.assert("facebook", "conversations")).toThrow(expect.objectContaining({ code: "CAPABILITY_NOT_SUPPORTED" }));
  });

  it("does not advertise unimplemented features", () => {
    for (const n of SOCIAL_NETWORKS) {
      expect(catalog.features(n).comments).toBe(false);
      expect(catalog.features(n).firstComment).toBe(false);
    }
  });

  it("unknown networks have no features", () => {
    expect(catalog.describe("x")).toBeUndefined();
    expect(catalog.supports("x", "publish")).toBe(false);
  });

  it("another gateway can supply its own catalog without changing the contract", () => {
    const other = new NetworkCatalog({
      facebook: {
        ...(OUTSTAND_SOCIAL_NETWORKS.facebook as NetworkDescriptor),
        capabilities: { ...OUTSTAND_SOCIAL_NETWORKS.facebook.capabilities, conversations: true, directMessages: true },
      },
    });
    expect(other.networks().map((d) => d.network)).toEqual(["facebook"]);
    expect(other.supports("facebook", "conversations")).toBe(true);
    expect(other.supports("linkedin", "publish")).toBe(false);
  });
});
