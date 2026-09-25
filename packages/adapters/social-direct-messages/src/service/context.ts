import type { GatewayContext } from "@zeptly-gateway/gateway-core";
import type { NetworkCatalog } from "@zeptly-gateway/social-publishing";
import type { SocialDirectMessagesPort } from "../port.js";

export interface SocialDirectMessagesContext extends GatewayContext {
  messaging: SocialDirectMessagesPort;
  /** Per-network features (conversations / directMessages flags). */
  socialCatalog: NetworkCatalog;
}
