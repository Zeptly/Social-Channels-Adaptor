import { CapabilityRouter } from "@zeptly-social/capability-registry";
import type { Database } from "@zeptly-social/database";
import { type Logger, registerSecret } from "@zeptly-social/observability";
import { ProviderRegistry, type SocialProvider } from "@zeptly-social/provider-contract";
import { OutstandProvider } from "@zeptly-social/provider-outstand";
import type { AppConfig } from "./config.js";
import type { ServiceContext } from "./context.js";

export function buildProviders(config: AppConfig, logger: Logger, fetchImpl?: typeof fetch): SocialProvider[] {
  return [
    new OutstandProvider({
      apiKey: config.OUTSTAND_API_KEY,
      webhookSecret: config.OUTSTAND_WEBHOOK_SECRET,
      baseUrl: config.OUTSTAND_API_BASE_URL,
      schedulingHorizonDays: config.OUTSTAND_SCHEDULING_HORIZON_DAYS,
      logger: logger.child({ component: "provider-outstand" }),
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  ];
}

export function createServiceContext(opts: {
  config: AppConfig;
  db: Database;
  logger: Logger;
  providers?: SocialProvider[];
  inlineDispatch?: boolean;
  now?: () => Date;
  skipMediaDnsCheck?: boolean;
}): ServiceContext {
  const { config } = opts;
  registerSecret(config.ZEPTLY_SERVICE_SECRET);
  registerSecret(config.ZEPTLY_SERVICE_SECRET_PREVIOUS);
  registerSecret(config.OUTSTAND_API_KEY);
  registerSecret(config.OUTSTAND_WEBHOOK_SECRET);
  return {
    db: opts.db,
    providers: new ProviderRegistry(opts.providers ?? buildProviders(config, opts.logger)),
    router: new CapabilityRouter(),
    logger: opts.logger,
    settings: {
      publicBaseUrl: config.PUBLIC_BASE_URL,
      allowedReturnOrigins: config.ALLOWED_RETURN_URL_ORIGINS,
      handoffMarginMs: config.OUTSTAND_HANDOFF_MARGIN_MINUTES * 60_000,
      inlineDispatch: opts.inlineDispatch ?? true,
      ...(opts.skipMediaDnsCheck ? { skipMediaDnsCheck: true } : {}),
    },
    now: opts.now ?? (() => new Date()),
  };
}
