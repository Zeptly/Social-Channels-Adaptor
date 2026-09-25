import { auditEvents, type Executor, providerEvents } from "@zeptly-gateway/database";
import { redact } from "@zeptly-gateway/observability";
import type { Actor, SystemActor } from "./context.js";

export interface AuditInput {
  workspaceId: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/** Records an audit event. Metadata is redacted; never pass content bodies or credentials. */
export async function recordAudit(tx: Executor, actor: Actor | SystemActor, input: AuditInput): Promise<void> {
  const isWorkspaceActor = "workspace" in actor;
  await tx.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    action: input.action,
    actorService: actor.service,
    actorAgent: isWorkspaceActor ? (actor.agent ?? null) : null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    requestId: actor.requestId,
    metadata: redact(input.metadata ?? {}),
  });
}

export async function recordProviderEvent(
  tx: Executor,
  input: {
    workspaceId: string | null;
    provider: string;
    source: "webhook" | "reconciliation" | "dispatch";
    type: string;
    resourceType?: string;
    resourceId?: string;
    summary?: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await tx.insert(providerEvents).values({
    workspaceId: input.workspaceId,
    provider: input.provider,
    source: input.source,
    type: input.type,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    summary: redact(input.summary ?? {}),
    occurredAt: input.occurredAt,
  });
}
