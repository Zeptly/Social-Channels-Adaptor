import { CreateConnectionRequestSchema, SOCIAL_NETWORKS, type NetworkDescriptor } from "@zeptly-social/domain";
import { describe, expect, it } from "vitest";
import { CapabilityRouter, OUTSTAND_NETWORKS, OUTSTAND_TABLE, type ProviderCapabilityTable } from "../src/index.js";

describe("V1 network boundary", () => {
  it("exposes exactly the Outstand Managed-Key networks", () => {
    expect(Object.keys(OUTSTAND_NETWORKS).sort()).toEqual([...SOCIAL_NETWORKS].sort());
    expect(SOCIAL_NETWORKS).toHaveLength(8);
  });

  it.each(["x", "twitter", "reddit", "google_business", "vimeo"])("rejects BYOK network %s at the contract", (network) => {
    expect(CreateConnectionRequestSchema.safeParse({ network }).success).toBe(false);
  });
});

describe("capability routing", () => {
  const router = new CapabilityRouter();

  it("resolves every supported capability to outstand in V1", () => {
    expect(router.resolve({ capability: "publish", network: "linkedin" })).toBe("outstand");
    expect(router.resolve({ capability: "conversations", network: "instagram" })).toBe("outstand");
  });

  it("advertises conversations only where verified (Instagram DMs)", () => {
    for (const n of SOCIAL_NETWORKS) {
      expect(router.capabilities(n).conversations).toBe(n === "instagram");
      expect(router.capabilities(n).directMessages).toBe(n === "instagram");
    }
    expect(() => router.resolve({ capability: "conversations", network: "facebook" })).toThrow(expect.objectContaining({ code: "CAPABILITY_NOT_SUPPORTED" }));
  });

  it("does not advertise unimplemented capabilities", () => {
    for (const n of SOCIAL_NETWORKS) {
      expect(router.capabilities(n).comments).toBe(false);
      expect(router.capabilities(n).firstComment).toBe(false);
    }
  });

  it("Bluesky supports provider-managed and credential strategies (not OAuth-only)", () => {
    expect(router.describe("bluesky")?.supportedStrategies).toEqual(["provider_managed", "credentials"]);
  });

  it("adds a future provider (e.g. analytics-only) without changing callers", () => {
    const analyticsOnly = Object.fromEntries(
      SOCIAL_NETWORKS.map((n) => [
        n,
        {
          ...(OUTSTAND_NETWORKS[n] as NetworkDescriptor),
          capabilities: { ...Object.fromEntries(Object.keys(OUTSTAND_NETWORKS[n].capabilities).map((k) => [k, false])), analytics: true, conversations: n === "facebook" },
        },
      ]),
    ) as ProviderCapabilityTable["networks"];
    const future = { provider: "zernio", version: "test", networks: analyticsOnly } as unknown as ProviderCapabilityTable;
    const r = new CapabilityRouter([OUTSTAND_TABLE, future], new Map([["ws_pilot", ["zernio" as never]]]));
    expect(r.resolve({ capability: "publish", network: "facebook" })).toBe("outstand");
    expect(r.resolve({ capability: "conversations", network: "facebook" })).toBe("zernio");
    expect(r.resolve({ capability: "analytics", network: "linkedin" })).toBe("outstand");
    expect(r.resolve({ capability: "analytics", network: "linkedin", workspaceId: "ws_pilot" })).toBe("zernio");
    expect(r.capabilities("facebook").conversations).toBe(true);
  });
});
