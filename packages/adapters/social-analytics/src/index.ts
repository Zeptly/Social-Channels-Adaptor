/**
 * Social Analytics capability (contract "social.analytics.basic" v1). The
 * Outstand implementation of the port lives under the "./outstand" subpath.
 */
export * from "./contract.js";
export * from "./port.js";
export type { SocialAnalyticsContext } from "./service/context.js";
export * as metrics from "./service/metrics.js";
export { toMetric } from "./service/serializers.js";
export { socialAnalyticsModule } from "./service/module.js";
