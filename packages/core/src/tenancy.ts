import { randomBytes } from "node:crypto";
import { SocialError } from "@zeptly-social/domain";
import {
  type Executor,
  providerAccounts,
  type ProviderAccountRow,
  type SocialConnectionRow,
  socialConnections,
  type Workspace,
  workspaces,
} from "@zeptly-social/database";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Tenancy guards. Every lookup of a tenant-owned resource goes through a
 * function here that constrains on workspace_id. A resource belonging to a
 * different workspace is reported as NOT FOUND (no existence oracle).
 */

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidWorkspaceExternalId(id: string): boolean {
  return WORKSPACE_ID_PATTERN.test(id);
}

/** Resolve (and lazily register) the local identity for a Zeptly workspace. */
export async function ensureWorkspace(db: Executor, externalId: string): Promise<Workspace> {
  if (!isValidWorkspaceExternalId(externalId)) {
    throw new SocialError("WORKSPACE_FORBIDDEN", "Invalid workspace identifier");
  }
  const existing = await db.select().from(workspaces).where(eq(workspaces.externalId, externalId)).limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(workspaces)
    .values({ externalId, providerTenantRef: `zs_${randomBytes(16).toString("hex")}` })
    .onConflictDoNothing({ target: workspaces.externalId })
    .returning();
  if (inserted[0]) return inserted[0];
  const again = await db.select().from(workspaces).where(eq(workspaces.externalId, externalId)).limit(1);
  if (!again[0]) throw new SocialError("INTERNAL_ERROR", "Workspace registration failed");
  return again[0];
}

export interface ConnectionWithAccount {
  connection: SocialConnectionRow;
  account: ProviderAccountRow;
}

/**
 * request workspace → Zeptly social connection → provider account mapping.
 * The mapping must itself carry the same workspace_id (defence in depth).
 */
export async function getConnectionForWorkspace(db: Executor, workspaceId: string, connectionId: string): Promise<ConnectionWithAccount> {
  const rows = await db
    .select({ connection: socialConnections, account: providerAccounts })
    .from(socialConnections)
    .innerJoin(providerAccounts, eq(providerAccounts.connectionId, socialConnections.id))
    .where(and(eq(socialConnections.id, connectionId), eq(socialConnections.workspaceId, workspaceId), eq(providerAccounts.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new SocialError("CONNECTION_NOT_FOUND", "Connection not found", { details: { connectionId } });
  return row;
}

export async function getConnectionsForWorkspace(db: Executor, workspaceId: string, connectionIds: string[]): Promise<Map<string, ConnectionWithAccount>> {
  if (connectionIds.length === 0) return new Map();
  const rows = await db
    .select({ connection: socialConnections, account: providerAccounts })
    .from(socialConnections)
    .innerJoin(providerAccounts, eq(providerAccounts.connectionId, socialConnections.id))
    .where(
      and(inArray(socialConnections.id, connectionIds), eq(socialConnections.workspaceId, workspaceId), eq(providerAccounts.workspaceId, workspaceId)),
    );
  return new Map(rows.map((r) => [r.connection.id, r]));
}

/** Provider reference → mapping. Used by webhooks: ownership comes only from stored mappings. */
export async function findAccountByExternalId(db: Executor, provider: string, externalId: string): Promise<ConnectionWithAccount | undefined> {
  const rows = await db
    .select({ connection: socialConnections, account: providerAccounts })
    .from(providerAccounts)
    .innerJoin(socialConnections, eq(providerAccounts.connectionId, socialConnections.id))
    .where(and(eq(providerAccounts.provider, provider), eq(providerAccounts.externalId, externalId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.account.workspaceId !== row.connection.workspaceId) return undefined;
  return row;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(id: string, code: "NOT_FOUND" | "CONNECTION_NOT_FOUND" | "POST_NOT_FOUND" | "CONVERSATION_NOT_FOUND" | "MEDIA_NOT_FOUND" | "PROVISIONING_NOT_FOUND"): void {
  if (!UUID_PATTERN.test(id)) throw new SocialError(code, "Resource not found");
}
