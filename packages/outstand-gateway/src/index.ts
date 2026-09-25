/**
 * @zeptly-gateway/outstand-gateway — the Outstand Gateway composition root:
 * configuration, Outstand channel catalog, provider-account port, webhook
 * source, capability composition and the Gateway Contract v1 implementation.
 */
export * from "./config.js";
export { OUTSTAND_CHANNELS } from "./channels.js";
export { OutstandAccountPort } from "./accounts.js";
export { outstandWebhookSource } from "./webhooks.js";
export {
  buildOutstandClient,
  createOutstandGateway,
  OUTSTAND_CAPABILITIES,
  type OutstandCapabilityId,
  type OutstandGatewayContext,
  type OutstandGatewayOptions,
  type OutstandGatewayRuntime,
} from "./gateway.js";
