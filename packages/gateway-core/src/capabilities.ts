import type { CapabilityAvailability, CapabilityDescriptor, WebhookEnvelope } from "@zeptly-gateway/gateway-contract";
import { gatewayConnections, providerAccounts, type Workspace } from "@zeptly-gateway/database";
import { and, eq, inArray } from "drizzle-orm";
import type { GatewayContext } from "./context.js";

export type JobHandler<C> = (ctx: C, payload: Record<string, unknown>) => Promise<unknown>;

export interface PeriodicJob {
  type: string;
  everyMs: number;
}

/** Work a worker performs on a fixed cadence outside the job queue (e.g. schedule hand-off). */
export interface WorkerTick<C> {
  name: string;
  everyMs: number;
  run(ctx: C, workerId: string): Promise<number>;
}

export interface WebhookHandlerResult {
  status: "processed" | "ignored";
  workspaceId?: string;
}

/** Claims normalized webhook events by `event.kind`. */
export interface WebhookEventHandler<C> {
  kinds: string[];
  handle(ctx: C, envelope: WebhookEnvelope): Promise<WebhookHandlerResult>;
}

/**
 * A capability implemented by this gateway. The gateway registry lists modules;
 * discovery reports which are enabled and which are available to a workspace.
 * There is no cross-provider routing: every module is backed by this gateway's
 * single provider.
 */
export interface CapabilityModule<C> {
  descriptor: Omit<CapabilityDescriptor, "enabled">;
  /** Channels on which this gateway offers the capability. */
  channels(): string[];
  jobs?: Record<string, JobHandler<C>>;
  periodic?: PeriodicJob[];
  ticks?: WorkerTick<C>[];
  webhookHandlers?: WebhookEventHandler<C>[];
  housekeeping?: (ctx: C) => Promise<void>;
}

export class CapabilityRegistry<C> {
  private readonly modules: CapabilityModule<C>[];
  private readonly disabled: ReadonlySet<string>;

  constructor(modules: CapabilityModule<C>[], disabled: Iterable<string> = []) {
    const ids = new Set<string>();
    for (const m of modules) {
      if (ids.has(m.descriptor.id)) throw new Error(`Duplicate capability ${m.descriptor.id}`);
      ids.add(m.descriptor.id);
    }
    this.modules = modules;
    this.disabled = new Set(disabled);
  }

  all(): CapabilityModule<C>[] {
    return [...this.modules];
  }

  get(id: string): CapabilityModule<C> | undefined {
    return this.modules.find((m) => m.descriptor.id === id);
  }

  isEnabled(id: string): boolean {
    return Boolean(this.get(id)) && !this.disabled.has(id);
  }

  descriptors(): CapabilityDescriptor[] {
    return this.modules.map((m) => ({ ...m.descriptor, enabled: !this.disabled.has(m.descriptor.id) }));
  }

  /**
   * Which capabilities can this workspace use right now? A capability is
   * available when it is enabled and the workspace has at least one active
   * connection (connected or degraded) on a channel that supports it.
   */
  async availability(ctx: GatewayContext, workspace: Workspace): Promise<CapabilityAvailability[]> {
    const rows = await ctx.db
      .select({ id: gatewayConnections.id, channel: gatewayConnections.network })
      .from(gatewayConnections)
      .innerJoin(providerAccounts, and(eq(providerAccounts.connectionId, gatewayConnections.id), eq(providerAccounts.workspaceId, workspace.id)))
      .where(and(eq(gatewayConnections.workspaceId, workspace.id), inArray(gatewayConnections.status, ["connected", "degraded"])));
    return this.descriptors().map((d) => {
      const channels = this.get(d.id)?.channels() ?? [];
      const connectionIds = rows.filter((r) => channels.includes(r.channel)).map((r) => r.id);
      const available = d.enabled && connectionIds.length > 0;
      return {
        ...d,
        available,
        channels,
        connectionIds,
        ...(available ? {} : { reason: d.enabled ? "No active connection on a supported channel" : "Disabled on this gateway" }),
      };
    });
  }
}
