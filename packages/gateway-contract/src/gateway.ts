import { z } from "zod";

/** Version of this contract. Additive changes keep "1"; breaking changes publish "2" alongside. */
export const GATEWAY_CONTRACT_VERSION = "1" as const;

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const GatewayIdentitySchema = z
  .object({
    gateway: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).describe('Stable gateway id, e.g. "outstand"'),
    provider: z.string().describe("Upstream provider represented by this gateway (one per gateway)"),
    displayName: z.string(),
    gatewayContractVersion: z.literal(GATEWAY_CONTRACT_VERSION),
    version: z.string().describe("Deployed gateway build version"),
  })
  .meta({ id: "GatewayIdentity" });
export type GatewayIdentity = z.infer<typeof GatewayIdentitySchema>;

/** The Zeptly workspace as seen by a gateway: an external identity, nothing more. */
export const WorkspaceIdentitySchema = z
  .object({
    workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).describe("Zeptly workspace identifier"),
  })
  .meta({ id: "WorkspaceIdentity" });
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

/**
 * Reference to an upstream provider object. Lives only inside a gateway's
 * integration records; it is never used to establish tenant ownership and is
 * never part of a canonical capability object.
 */
export interface ProviderReference {
  provider: string;
  kind: string;
  externalId: string;
}

/* ------------------------------------------------------------------ */
/* Request context                                                     */
/* ------------------------------------------------------------------ */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CorrelationId = Brand<string, "CorrelationId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function asIdempotencyKey(value: string): IdempotencyKey | undefined {
  return IDEMPOTENCY_KEY_PATTERN.test(value) ? (value as IdempotencyKey) : undefined;
}

export function asCorrelationId(value: string): CorrelationId | undefined {
  return CORRELATION_ID_PATTERN.test(value) ? (value as CorrelationId) : undefined;
}

/** Everything a gateway knows about an authenticated inbound request. */
export interface GatewayRequestContext {
  /** Authenticated calling service (e.g. "zeptly-app"). */
  caller: string;
  /** Present on workspace-scoped operations. */
  workspace?: WorkspaceIdentity;
  /** Optional Zeptly agent/user reference, recorded in audit. */
  agent?: string;
  correlationId: CorrelationId;
  idempotencyKey?: IdempotencyKey;
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const CapabilityDescriptorSchema = z
  .object({
    id: z.string().regex(CAPABILITY_ID_PATTERN).describe('Dotted capability id, e.g. "social.publishing"'),
    version: z.string().describe("Capability contract version implemented by the gateway"),
    enabled: z.boolean().describe("Offered by this gateway deployment"),
    title: z.string(),
    description: z.string(),
  })
  .meta({ id: "CapabilityDescriptor" });
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export const CapabilityAvailabilitySchema = CapabilityDescriptorSchema.extend({
  available: z.boolean().describe("Usable by this workspace right now (enabled and backed by at least one active connection)"),
  channels: z.array(z.string()).describe("Channels on which the gateway offers this capability"),
  connectionIds: z.array(z.uuid()).describe("This workspace's active connections that can use the capability"),
  reason: z.string().optional().describe("Why the capability is unavailable, when it is"),
}).meta({ id: "CapabilityAvailability" });
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;

export const GatewayDescriptorSchema = GatewayIdentitySchema.extend({
  capabilities: z.array(CapabilityDescriptorSchema),
  channels: z.array(z.string()).describe("Account channels the gateway can provision (e.g. networks)"),
}).meta({ id: "GatewayDescriptor" });
export type GatewayDescriptor = z.infer<typeof GatewayDescriptorSchema>;

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export const GatewayHealthSchema = z
  .object({
    status: z.enum(["ok", "degraded", "unavailable"]),
    checks: z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string().optional() })),
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "GatewayHealth" });
export type GatewayHealth = z.infer<typeof GatewayHealthSchema>;

/* ------------------------------------------------------------------ */
/* The gateway                                                         */
/* ------------------------------------------------------------------ */

/** What every provider gateway implements, regardless of its capabilities. */
export interface Gateway {
  describe(): GatewayDescriptor;
  capabilities(workspaceId: string): Promise<CapabilityAvailability[]>;
  /** Must not generate upstream provider traffic. */
  health(): Promise<GatewayHealth>;
}
