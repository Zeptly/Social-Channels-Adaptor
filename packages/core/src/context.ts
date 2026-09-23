import type { CapabilityRouter } from "@zeptly-social/capability-registry";
import type { Database } from "@zeptly-social/database";
import type { Logger } from "@zeptly-social/observability";
import type { ProviderRegistry } from "@zeptly-social/provider-contract";
import type { Workspace } from "@zeptly-social/database";

export interface CoreSettings {
  publicBaseUrl: string;
  allowedReturnOrigins: string[];
  /** Provider scheduling horizon handoff margin. */
  handoffMarginMs: number;
  /** Dispatch immediately from the API process after publish (same claim path as the worker). */
  inlineDispatch: boolean;
  /** Skip DNS resolution in media URL checks (tests only). */
  skipMediaDnsCheck?: boolean;
}

export interface ServiceContext {
  db: Database;
  providers: ProviderRegistry;
  router: CapabilityRouter;
  logger: Logger;
  settings: CoreSettings;
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

/** Non-workspace actor for worker / webhook initiated work. */
export interface SystemActor {
  service: "worker" | "webhook:outstand" | "admin";
  requestId: string;
}
