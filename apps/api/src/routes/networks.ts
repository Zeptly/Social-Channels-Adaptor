import type { OutstandGatewayRuntime } from "@zeptly-gateway/outstand-gateway";
import { NetworkDescriptorSchema } from "@zeptly-gateway/social-publishing";
import { OUTSTAND_SOCIAL_CATALOG_VERSION } from "@zeptly-gateway/social-publishing/outstand";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponses } from "../app.js";
import { security, workspaceHeaders, zapp } from "./common.js";

const Strategy = z.enum(["oauth_redirect", "provider_managed", "credentials"]);
const NetworkInfo = NetworkDescriptorSchema.extend({
  connectionStrategy: Strategy.describe("Default provisioning strategy (from GET /v1/connections/channels)"),
  supportedStrategies: z.array(Strategy),
}).meta({ id: "SocialNetworkInfo" });
const NetworkList = z
  .object({ data: z.array(NetworkInfo), registryVersion: z.string().describe("Version of this gateway's verified network catalog") })
  .meta({ id: "NetworkList" });

/** Social Publishing networks: verified per-network features and constraints on this gateway. */
export function registerNetworkRoutes(app: FastifyInstance, rt: OutstandGatewayRuntime): void {
  const r = zapp(app);
  for (const path of ["/v1/social/publishing/networks", "/v1/networks"]) {
    r.get(
      path,
      {
        schema: {
          tags: ["social-publishing"],
          summary: "Supported networks with features, constraints and connection strategies",
          security,
          headers: workspaceHeaders,
          response: { 200: NetworkList, ...errorResponses },
        },
      },
      async () => ({
        data: rt.ctx.socialCatalog.networks().map((d) => {
          const ch = rt.ctx.channels.get(d.network);
          return { ...d, connectionStrategy: ch?.connectionStrategy ?? "oauth_redirect", supportedStrategies: ch?.supportedStrategies ?? ["oauth_redirect"] };
        }),
        registryVersion: OUTSTAND_SOCIAL_CATALOG_VERSION,
      }),
    );
  }
}
