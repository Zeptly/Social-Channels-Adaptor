import type { CapabilityAvailability, Gateway, GatewayConnection, GatewayDescriptor, GatewayHealth } from "@zeptly-gateway/gateway-contract";
import { GATEWAY_CONTRACT_VERSION } from "@zeptly-gateway/gateway-contract";
import type { Database } from "@zeptly-gateway/database";
import {
  type CapabilityModule,
  CapabilityRegistry,
  type ConnectionsContext,
  ensureWorkspace,
  GATEWAY_PERIODIC_JOBS,
  gatewayJobHandlers,
  gatewayWebhookHandlers,
  type JobHandler,
  type PeriodicJob,
  staticChannelCatalog,
  type WebhookContext,
  type WebhookEventHandler,
  type WorkerTick,
} from "@zeptly-gateway/gateway-core";
import { type Logger, registerSecret } from "@zeptly-gateway/observability";
import { OUTSTAND, OutstandClient } from "@zeptly-gateway/outstand-client";
import { type SocialAnalyticsContext, socialAnalyticsModule } from "@zeptly-gateway/social-analytics";
import { OutstandSocialAnalyticsAdapter } from "@zeptly-gateway/social-analytics/outstand";
import { type SocialDirectMessagesContext, socialDirectMessagesModule } from "@zeptly-gateway/social-direct-messages";
import { OutstandSocialDirectMessagesAdapter } from "@zeptly-gateway/social-direct-messages/outstand";
import { NetworkCatalog, type SocialConnection, type SocialPublishingContext, socialPublishingModule, socialSchedulingModule, toSocialConnection } from "@zeptly-gateway/social-publishing";
import { OUTSTAND_SOCIAL_CATALOG_VERSION, OUTSTAND_SOCIAL_NETWORKS, OutstandSocialPublishingAdapter } from "@zeptly-gateway/social-publishing/outstand";
import { OutstandAccountPort } from "./accounts.js";
import { OUTSTAND_CHANNELS } from "./channels.js";
import type { AppConfig } from "./config.js";
import { outstandWebhookSource } from "./webhooks.js";

/** Everything the Outstand gateway's infrastructure and capabilities receive. */
export type OutstandGatewayContext = ConnectionsContext & WebhookContext & SocialPublishingContext & SocialAnalyticsContext & SocialDirectMessagesContext;

export type OutstandCapabilityId = "social.publishing" | "social.scheduling" | "social.analytics.basic" | "social.direct_messages";
export const OUTSTAND_CAPABILITIES: readonly OutstandCapabilityId[] = ["social.publishing", "social.scheduling", "social.analytics.basic", "social.direct_messages"];

export interface OutstandGatewayOptions {
  config: AppConfig;
  db: Database;
  logger: Logger;
  /** Injected client (tests); otherwise built from config. */
  client?: OutstandClient;
  /** Custom fetch for the built client (tests use the Outstand fake). */
  fetchImpl?: typeof fetch;
  /** Capability modules composed into this deployment (default: all). */
  capabilities?: readonly OutstandCapabilityId[];
  /** Dispatch from the API process right after publish (default true; the worker passes false). */
  inlineDispatch?: boolean;
  now?: () => Date;
  skipMediaDnsCheck?: boolean;
  version?: string;
  /** Local health checks (database, migrations); must not call Outstand. */
  healthProbe?: () => Promise<Record<string, { ok: boolean; detail?: string }>>;
}

export interface OutstandGatewayRuntime {
  gateway: Gateway;
  ctx: OutstandGatewayContext;
  registry: CapabilityRegistry<OutstandGatewayContext>;
  jobs: Record<string, JobHandler<OutstandGatewayContext>>;
  periodic: PeriodicJob[];
  ticks: WorkerTick<OutstandGatewayContext>[];
  client: OutstandClient;
  /** Connection as returned by the API: social view when Social Publishing is composed. */
  presentConnection(c: GatewayConnection): GatewayConnection | SocialConnection;
}

export function buildOutstandClient(config: AppConfig, logger: Logger, opts: { fetchImpl?: typeof fetch; now?: () => Date } = {}): OutstandClient {
  return new OutstandClient({
    apiKey: config.OUTSTAND_API_KEY,
    webhookSecret: config.OUTSTAND_WEBHOOK_SECRET,
    baseUrl: config.OUTSTAND_API_BASE_URL,
    schedulingHorizonDays: config.OUTSTAND_SCHEDULING_HORIZON_DAYS,
    enablePostUpdate: config.OUTSTAND_POST_UPDATE_ENABLED,
    logger: logger.child({ component: "outstand-client" }),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
}

/**
 * Composition root of the Outstand Gateway: Outstand client → typed capability
 * adapters → capability services, on top of gateway-core infrastructure.
 */
export function createOutstandGateway(opts: OutstandGatewayOptions): OutstandGatewayRuntime {
  const { config } = opts;
  registerSecret(config.ZEPTLY_SERVICE_SECRET);
  registerSecret(config.ZEPTLY_SERVICE_SECRET_PREVIOUS);
  registerSecret(config.OUTSTAND_API_KEY);
  registerSecret(config.OUTSTAND_WEBHOOK_SECRET);
  const now = opts.now ?? (() => new Date());
  const client = opts.client ?? buildOutstandClient(config, opts.logger, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), now });
  const selected = new Set(opts.capabilities ?? OUTSTAND_CAPABILITIES);
  const socialCatalog = new NetworkCatalog(OUTSTAND_SOCIAL_NETWORKS);

  const modules: CapabilityModule<OutstandGatewayContext>[] = [];
  const networksWith = (f: "publish" | "schedule" | "analytics" | "conversations") => () => socialCatalog.networksWith(f);
  if (selected.has("social.publishing")) modules.push(socialPublishingModule(networksWith("publish")) as CapabilityModule<OutstandGatewayContext>);
  if (selected.has("social.scheduling")) modules.push(socialSchedulingModule(networksWith("schedule")) as CapabilityModule<OutstandGatewayContext>);
  if (selected.has("social.analytics.basic")) modules.push(socialAnalyticsModule(networksWith("analytics")) as CapabilityModule<OutstandGatewayContext>);
  if (selected.has("social.direct_messages")) modules.push(socialDirectMessagesModule(networksWith("conversations")) as CapabilityModule<OutstandGatewayContext>);
  const registry = new CapabilityRegistry<OutstandGatewayContext>(modules);

  const webhookHandlers: WebhookEventHandler<OutstandGatewayContext>[] = [
    ...(gatewayWebhookHandlers() as WebhookEventHandler<OutstandGatewayContext>[]),
    ...modules.flatMap((m) => m.webhookHandlers ?? []),
  ];

  const ctx: OutstandGatewayContext = {
    gatewayId: OUTSTAND,
    db: opts.db,
    logger: opts.logger,
    settings: { publicBaseUrl: config.PUBLIC_BASE_URL, allowedReturnOrigins: config.ALLOWED_RETURN_URL_ORIGINS },
    now,
    accounts: new OutstandAccountPort(client),
    channels: staticChannelCatalog(OUTSTAND_CHANNELS),
    webhookSource: outstandWebhookSource(config.OUTSTAND_WEBHOOK_SECRET),
    webhookHandlers: webhookHandlers as WebhookEventHandler<never>[],
    publishing: new OutstandSocialPublishingAdapter(client),
    socialCatalog,
    publishingSettings: {
      handoffMarginMs: config.OUTSTAND_HANDOFF_MARGIN_MINUTES * 60_000,
      inlineDispatch: opts.inlineDispatch ?? true,
      ...(opts.skipMediaDnsCheck ? { skipMediaDnsCheck: true } : {}),
    },
    analytics: new OutstandSocialAnalyticsAdapter(client),
    messaging: new OutstandSocialDirectMessagesAdapter(client),
  };

  const housekeepingHooks = modules.flatMap((m) => (m.housekeeping ? [m.housekeeping] : []));
  const jobs: Record<string, JobHandler<OutstandGatewayContext>> = { ...gatewayJobHandlers<OutstandGatewayContext>(housekeepingHooks) };
  for (const m of modules) {
    for (const [type, handler] of Object.entries(m.jobs ?? {})) {
      if (jobs[type]) throw new Error(`Duplicate job type ${type}`);
      jobs[type] = handler;
    }
  }
  const periodic = [...GATEWAY_PERIODIC_JOBS, ...modules.flatMap((m) => m.periodic ?? [])];
  const ticks = modules.flatMap((m) => m.ticks ?? []);

  const identity = {
    gateway: OUTSTAND,
    provider: OUTSTAND,
    displayName: "Outstand Gateway",
    gatewayContractVersion: GATEWAY_CONTRACT_VERSION,
    version: opts.version ?? "1.0.0",
  } as const;

  const gateway: Gateway = {
    describe(): GatewayDescriptor {
      return { ...identity, capabilities: registry.descriptors(), channels: OUTSTAND_CHANNELS.map((c) => c.channel) };
    },
    async capabilities(workspaceId: string): Promise<CapabilityAvailability[]> {
      const ws = await ensureWorkspace(ctx.db, workspaceId);
      return registry.availability(ctx, ws);
    },
    async health(): Promise<GatewayHealth> {
      let checks: GatewayHealth["checks"];
      try {
        checks = opts.healthProbe ? await opts.healthProbe() : {};
      } catch {
        checks = { probe: { ok: false, detail: "health probe failed" } };
      }
      checks.catalog = { ok: true, detail: `outstand social catalog ${OUTSTAND_SOCIAL_CATALOG_VERSION}` };
      const failed = Object.values(checks).filter((c) => !c.ok).length;
      return { status: failed === 0 ? "ok" : checks.database?.ok === false ? "unavailable" : "degraded", checks, checkedAt: now().toISOString() };
    },
  };

  const social = registry.get("social.publishing") !== undefined;
  return {
    gateway,
    ctx,
    registry,
    jobs,
    periodic,
    ticks,
    client,
    presentConnection: (c) => (social ? toSocialConnection(c, socialCatalog) : c),
  };
}
