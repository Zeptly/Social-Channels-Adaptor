import type { GatewayContext } from "@zeptly-gateway/gateway-core";
import type { SocialPublishingPort } from "../port.js";
import type { NetworkCatalog } from "./catalog.js";

export interface SocialPublishingSettings {
  /** Safety margin subtracted from the provider scheduling horizon at hand-off. */
  handoffMarginMs: number;
  /** Dispatch immediately from the API process after publish (same claim path as the worker). */
  inlineDispatch: boolean;
  /** Skip DNS resolution in media URL checks (tests only). */
  skipMediaDnsCheck?: boolean;
}

/**
 * What the Social Publishing service needs: gateway infrastructure plus one
 * provider port and the gateway's network catalog. The provider is fixed by
 * the gateway — there is no per-request provider selection.
 */
export interface SocialPublishingContext extends GatewayContext {
  publishing: SocialPublishingPort;
  socialCatalog: NetworkCatalog;
  publishingSettings: SocialPublishingSettings;
}
