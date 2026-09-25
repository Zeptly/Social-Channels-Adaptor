import type { Database, Workspace } from "@zeptly-gateway/database";
import type { Logger } from "@zeptly-gateway/observability";

export interface GatewaySettings {
  /** Public HTTPS origin of this gateway (provider OAuth redirects land here). */
  publicBaseUrl: string;
  /** Zeptly origins allowed as provisioning returnUrl (open-redirect protection). */
  allowedReturnOrigins: string[];
}

/**
 * What every piece of gateway infrastructure receives. Capability packages
 * extend it structurally with their own ports; nothing here knows about a
 * specific provider or capability domain.
 */
export interface GatewayContext {
  /** Gateway id, e.g. "outstand"; also the provider recorded on connections. */
  gatewayId: string;
  db: Database;
  logger: Logger;
  settings: GatewaySettings;
  now: () => Date;
}

/** The authenticated caller acting on behalf of one Zeptly workspace. */
export interface Actor {
  workspace: Workspace;
  /** Authenticated calling service identity, e.g. "zeptly-app". */
  service: string;
  /** Optional Zeptly agent/user reference for audit. */
  agent?: string;
  requestId: string;
}

/** Non-workspace actor for worker / webhook / admin initiated work. */
export interface SystemActor {
  service: string;
  requestId: string;
}
