import { createHash, randomBytes } from "node:crypto";
import {
  type CreateConnectionRequest,
  type NetworkDescriptor,
  type ProvisioningSession,
  type ReconnectRequest,
  type SocialConnection,
  SocialError,
  type SocialNetwork,
} from "@zeptly-social/domain";
import {
  type Executor,
  providerAccounts,
  type ProvisioningSessionRow,
  provisioningSessions,
  type SocialConnectionRow,
  socialConnections,
  type Workspace,
  workspaces,
} from "@zeptly-social/database";
import type { ProviderAccount, SocialProvider } from "@zeptly-social/provider-contract";
import { and, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { recordAudit, recordProviderEvent } from "./audit.js";
import type { Actor, ServiceContext, SystemActor } from "./context.js";
import { toSocialError } from "./provider-errors.js";
import { toConnection, toProvisioning } from "./serializers.js";
import { assertUuid, getConnectionForWorkspace } from "./tenancy.js";

export const PROVISIONING_TTL_MS = 30 * 60_000;
/** Accounts carrying our tenant ref may be adopted by reconciliation only within this window of a provisioning session. */
const ADOPTION_WINDOW_MS = 24 * 3600_000;

const hashState = (state: string) => createHash("sha256").update(state).digest("hex");

export function listNetworks(ctx: ServiceContext): NetworkDescriptor[] {
  return ctx.router.networks();
}

function assertReturnUrl(ctx: ServiceContext, returnUrl: string | undefined): string {
  if (!returnUrl) throw new SocialError("VALIDATION_ERROR", "returnUrl is required for this connection strategy");
  let origin: string;
  try {
    const u = new URL(returnUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    origin = u.origin;
  } catch {
    throw new SocialError("VALIDATION_ERROR", "returnUrl is not a valid URL");
  }
  if (!ctx.settings.allowedReturnOrigins.includes(origin)) {
    throw new SocialError("VALIDATION_ERROR", "returnUrl origin is not allowed", { details: { origin } });
  }
  return returnUrl;
}

export interface ConnectionResult {
  provisioning: ProvisioningSession;
  connections: SocialConnection[];
}

/** POST /v1/connections — initiate provisioning for a network. */
export async function createConnection(ctx: ServiceContext, actor: Actor, req: CreateConnectionRequest, reconnect?: SocialConnectionRow): Promise<ConnectionResult> {
  const network = req.network;
  const descriptor = ctx.router.describe(network);
  if (!descriptor) throw new SocialError("NETWORK_NOT_SUPPORTED", "Network is not supported");
  const providerName = reconnect?.provider ?? ctx.router.resolve({ capability: "connect", network, workspaceId: actor.workspace.externalId });
  ctx.router.assert(providerName, network, "connect");
  const provider = ctx.providers.get(providerName);
  const now = ctx.now();
  const ws = actor.workspace;

  if (req.credentials) {
    if (!descriptor.supportedStrategies.includes("credentials") || !provider.connectWithCredentials) {
      throw new SocialError("CAPABILITY_NOT_SUPPORTED", `Credential-based connection is not supported for ${network}`, { details: { network } });
    }
    const [session] = await ctx.db
      .insert(provisioningSessions)
      .values({
        workspaceId: ws.id,
        network,
        provider: providerName,
        strategy: "credentials",
        status: "initiated",
        reconnectConnectionId: reconnect?.id ?? null,
        createdBy: actor.agent ?? actor.service,
        expiresAt: new Date(now.getTime() + PROVISIONING_TTL_MS),
      })
      .returning();
    if (!session) throw new SocialError("INTERNAL_ERROR", "Could not create provisioning session");
    let accounts: ProviderAccount[];
    try {
      // Credentials are forwarded once and never persisted or logged.
      accounts = await provider.connectWithCredentials({ network, tenantRef: ws.providerTenantRef, credentials: req.credentials });
    } catch (err) {
      const se = toSocialError(err);
      await failSession(ctx.db, session.id, se.code, se.message);
      await recordAudit(ctx.db, actor, { workspaceId: ws.id, action: "connection.failed", resourceType: "provisioning", resourceId: session.id, metadata: { network, code: se.code } });
      throw se;
    }
    return completeWithAccounts(ctx, actor, session, accounts);
  }

  const returnUrl = assertReturnUrl(ctx, req.returnUrl);
  const state = randomBytes(32).toString("base64url");
  const redirectUri = `${ctx.settings.publicBaseUrl.replace(/\/+$/, "")}/v1/connect/callback/${state}`;
  let authorizationUrl: string;
  try {
    ({ authorizationUrl } = await provider.initiateConnection({ network, redirectUri, tenantRef: ws.providerTenantRef }));
  } catch (err) {
    throw toSocialError(err);
  }
  const [session] = await ctx.db
    .insert(provisioningSessions)
    .values({
      workspaceId: ws.id,
      network,
      provider: providerName,
      strategy: descriptor.connectionStrategy === "credentials" ? "provider_managed" : descriptor.connectionStrategy,
      status: "initiated",
      stateHash: hashState(state),
      returnUrl,
      authorizationUrl,
      reconnectConnectionId: reconnect?.id ?? null,
      createdBy: actor.agent ?? actor.service,
      expiresAt: new Date(now.getTime() + PROVISIONING_TTL_MS),
    })
    .returning();
  if (!session) throw new SocialError("INTERNAL_ERROR", "Could not create provisioning session");
  await recordAudit(ctx.db, actor, {
    workspaceId: ws.id,
    action: reconnect ? "connection.reconnect_initiated" : "connection.initiated",
    resourceType: "provisioning",
    resourceId: session.id,
    metadata: { network, strategy: session.strategy, ...(reconnect ? { connectionId: reconnect.id } : {}) },
  });
  return { provisioning: toProvisioning(session, ws), connections: [] };
}

async function failSession(db: Executor, id: string, code: string, message: string): Promise<void> {
  await db
    .update(provisioningSessions)
    .set({ status: "failed", errorCode: code, errorMessage: message.slice(0, 500), providerSessionToken: null, updatedAt: new Date() })
    .where(eq(provisioningSessions.id, id));
}

/**
 * GET /v1/connect/callback/:state — public browser redirect target. The state
 * token (not the query) binds the callback to exactly one provisioning session
 * and therefore one workspace. Returns the Zeptly URL to redirect the browser to.
 */
export async function handleProviderCallback(ctx: ServiceContext, state: string, query: { session?: string; error?: string }): Promise<string> {
  const rows = await ctx.db.select().from(provisioningSessions).where(eq(provisioningSessions.stateHash, hashState(state))).limit(1);
  const session = rows[0];
  if (!session?.returnUrl) throw new SocialError("PROVISIONING_NOT_FOUND", "Unknown or already used provisioning link");
  const back = (status: string) => {
    const u = new URL(session.returnUrl as string);
    u.searchParams.set("provisioningId", session.id);
    u.searchParams.set("status", status);
    return u.toString();
  };
  if (session.status !== "initiated") return back(session.status);
  const now = ctx.now();
  if (session.expiresAt < now) {
    await ctx.db.update(provisioningSessions).set({ status: "expired", updatedAt: now }).where(eq(provisioningSessions.id, session.id));
    return back("expired");
  }
  const system: SystemActor = { service: "worker", requestId: `callback:${session.id}` };
  if (query.error || !query.session) {
    await failSession(ctx.db, session.id, "PROVIDER_REJECTED", query.error ? "Authorization was declined or failed at the provider" : "Provider callback carried no session");
    await recordAudit(ctx.db, system, { workspaceId: session.workspaceId, action: "connection.failed", resourceType: "provisioning", resourceId: session.id, metadata: { network: session.network } });
    return back("failed");
  }
  const provider = ctx.providers.get(session.provider);
  try {
    const pending = await provider.getPendingConnection(query.session);
    if (pending.network !== session.network) {
      await failSession(ctx.db, session.id, "TARGET_INVALID", "Provider session belongs to a different network");
      return back("failed");
    }
    await ctx.db
      .update(provisioningSessions)
      .set({
        status: "awaiting_selection",
        providerSessionToken: query.session,
        options: pending.options as unknown as Array<Record<string, unknown>>,
        ...(pending.expiresAt && pending.expiresAt < session.expiresAt ? { expiresAt: pending.expiresAt } : {}),
        updatedAt: now,
      })
      .where(and(eq(provisioningSessions.id, session.id), eq(provisioningSessions.status, "initiated")));
    // Single-account networks need no selection: finalize immediately.
    if (pending.options.length <= 1) {
      const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1);
      if (!ws) throw new SocialError("INTERNAL_ERROR", "workspace missing");
      const actor: Actor = { workspace: ws, service: "provisioning-callback", requestId: system.requestId };
      const res = await finalizeProvisioning(ctx, actor, session.id, { optionIds: pending.options.map((o) => o.id) });
      return back(res.provisioning.status);
    }
    return back("awaiting_selection");
  } catch (err) {
    const se = toSocialError(err);
    ctx.logger.warn({ provisioningId: session.id, code: se.code, err }, "provisioning callback failed");
    if (se.code === "PROVIDER_UNAVAILABLE" || se.code === "PROVIDER_RATE_LIMITED") {
      // Keep the session recoverable; Zeptly can retry finalize later.
      return back("awaiting_selection");
    }
    await failSession(ctx.db, session.id, se.code, se.message);
    return back("failed");
  }
}

async function loadSession(ctx: ServiceContext, ws: Workspace, id: string): Promise<ProvisioningSessionRow> {
  assertUuid(id, "PROVISIONING_NOT_FOUND");
  const rows = await ctx.db
    .select()
    .from(provisioningSessions)
    .where(and(eq(provisioningSessions.id, id), eq(provisioningSessions.workspaceId, ws.id)))
    .limit(1);
  if (!rows[0]) throw new SocialError("PROVISIONING_NOT_FOUND", "Provisioning session not found");
  return rows[0];
}

export async function getProvisioning(ctx: ServiceContext, actor: Actor, id: string): Promise<ProvisioningSession> {
  const s = await loadSession(ctx, actor.workspace, id);
  if ((s.status === "initiated" || s.status === "awaiting_selection") && s.expiresAt < ctx.now()) {
    await ctx.db.update(provisioningSessions).set({ status: "expired", providerSessionToken: null, updatedAt: ctx.now() }).where(eq(provisioningSessions.id, s.id));
    return toProvisioning({ ...s, status: "expired" }, actor.workspace);
  }
  return toProvisioning(s, actor.workspace);
}

export async function finalizeProvisioning(ctx: ServiceContext, actor: Actor, id: string, req: { optionIds: string[] }): Promise<ConnectionResult> {
  const session = await loadSession(ctx, actor.workspace, id);
  if (session.status === "completed") {
    const conns = session.connectionIds.length
      ? await ctx.db.select().from(socialConnections).where(and(inArray(socialConnections.id, session.connectionIds), eq(socialConnections.workspaceId, actor.workspace.id)))
      : [];
    return { provisioning: toProvisioning(session, actor.workspace), connections: conns.map((c) => toConnection(c, actor.workspace, ctx.router)) };
  }
  if (session.status !== "awaiting_selection" || !session.providerSessionToken) {
    throw new SocialError("INVALID_STATE", "Provisioning session is not awaiting selection", { details: { status: session.status } });
  }
  if (session.expiresAt < ctx.now()) {
    await ctx.db.update(provisioningSessions).set({ status: "expired", providerSessionToken: null, updatedAt: ctx.now() }).where(eq(provisioningSessions.id, session.id));
    throw new SocialError("PROVISIONING_EXPIRED", "Provisioning session expired; start a new connection");
  }
  const allowed = new Set((session.options ?? []).map((o) => String(o.id)));
  const unknown = req.optionIds.filter((o) => !allowed.has(o));
  if (unknown.length && allowed.size > 0) throw new SocialError("VALIDATION_ERROR", "Unknown option ids", { details: { optionIds: unknown } });
  const provider = ctx.providers.get(session.provider);
  let accounts: ProviderAccount[];
  try {
    accounts = await provider.finalizeConnection(session.providerSessionToken, req.optionIds);
  } catch (err) {
    const se = toSocialError(err);
    if (!se.retryable) await failSession(ctx.db, session.id, se.code, se.message);
    throw se;
  }
  return completeWithAccounts(ctx, actor, session, accounts);
}

/**
 * Map provider accounts returned by an authenticated provisioning flow into the
 * session's workspace. Ownership is proven by the session (state token / the
 * authenticated caller), never inferred from network or username. An account
 * already mapped to another workspace is refused (CONNECTION_OWNERSHIP_CONFLICT).
 */
async function completeWithAccounts(ctx: ServiceContext, actor: Actor, session: ProvisioningSessionRow, accounts: ProviderAccount[]): Promise<ConnectionResult> {
  const ws = actor.workspace;
  const now = ctx.now();
  const matching = accounts.filter((a) => a.network === session.network);
  const result = await ctx.db.transaction(async (tx) => {
    const connections: SocialConnectionRow[] = [];
    const conflicts: string[] = [];
    for (const a of matching) {
      const adopted = await adoptAccount(tx, ws, session.provider, session.network as SocialNetwork, a, now);
      if (adopted === "conflict") conflicts.push(a.externalId);
      else connections.push(adopted);
    }
    const ok = connections.length > 0;
    const [updated] = await tx
      .update(provisioningSessions)
      .set({
        status: ok ? "completed" : "failed",
        connectionIds: connections.map((c) => c.id),
        providerSessionToken: null,
        completedAt: ok ? now : null,
        errorCode: ok ? null : conflicts.length ? "CONNECTION_OWNERSHIP_CONFLICT" : "PROVIDER_REJECTED",
        errorMessage: ok ? null : conflicts.length ? "The account is already connected to another workspace" : "The provider returned no account for this network",
        updatedAt: now,
      })
      .where(eq(provisioningSessions.id, session.id))
      .returning();
    for (const c of connections) {
      await recordAudit(tx, actor, {
        workspaceId: ws.id,
        action: session.reconnectConnectionId ? "connection.reconnected" : "connection.established",
        resourceType: "connection",
        resourceId: c.id,
        metadata: { network: c.network, provisioningId: session.id },
      });
    }
    if (conflicts.length) {
      await recordAudit(tx, actor, { workspaceId: ws.id, action: "connection.ownership_conflict", resourceType: "provisioning", resourceId: session.id, metadata: { count: conflicts.length } });
    }
    return { session: updated ?? session, connections, conflicts };
  });
  if (result.connections.length === 0) {
    throw new SocialError(result.conflicts.length ? "CONNECTION_OWNERSHIP_CONFLICT" : "PROVIDER_REJECTED", result.session.errorMessage ?? "Provisioning failed", {
      details: { provisioningId: session.id },
    });
  }
  return {
    provisioning: toProvisioning(result.session, ws),
    connections: result.connections.map((c) => toConnection(c, ws, ctx.router)),
  };
}

async function adoptAccount(tx: Executor, ws: Workspace, provider: string, network: SocialNetwork, a: ProviderAccount, now: Date): Promise<SocialConnectionRow | "conflict"> {
  const profile = {
    displayName: a.displayName ?? a.username ?? null,
    username: a.username ?? null,
    avatarUrl: a.avatarUrl ?? null,
    accountType: a.accountType ?? null,
  };
  const existing = await tx.select().from(providerAccounts).where(and(eq(providerAccounts.provider, provider), eq(providerAccounts.externalId, a.externalId))).limit(1);
  const mapping = existing[0];
  if (mapping) {
    if (mapping.workspaceId !== ws.id) return "conflict";
    await tx.update(providerAccounts).set({ active: true, tenantRef: a.tenantRef ?? mapping.tenantRef, updatedAt: now }).where(eq(providerAccounts.id, mapping.id));
    const [conn] = await tx
      .update(socialConnections)
      .set({ ...profile, status: "connected", statusReason: null, connectedAt: now, lastCheckedAt: now, disconnectedAt: null, updatedAt: now })
      .where(and(eq(socialConnections.id, mapping.connectionId), eq(socialConnections.workspaceId, ws.id)))
      .returning();
    if (!conn) throw new SocialError("INTERNAL_ERROR", "Connection mapping inconsistent");
    return conn;
  }
  const [conn] = await tx
    .insert(socialConnections)
    .values({ workspaceId: ws.id, network, provider, status: "connected", ...profile, connectedAt: now, lastCheckedAt: now })
    .returning();
  if (!conn) throw new SocialError("INTERNAL_ERROR", "Could not create connection");
  const inserted = await tx
    .insert(providerAccounts)
    .values({ workspaceId: ws.id, connectionId: conn.id, provider, externalId: a.externalId, network, tenantRef: a.tenantRef ?? null })
    .onConflictDoNothing()
    .returning({ id: providerAccounts.id });
  if (inserted.length === 0) {
    // Lost a race with a concurrent adoption of the same account.
    await tx.delete(socialConnections).where(eq(socialConnections.id, conn.id));
    const again = await tx.select().from(providerAccounts).where(and(eq(providerAccounts.provider, provider), eq(providerAccounts.externalId, a.externalId))).limit(1);
    if (!again[0] || again[0].workspaceId !== ws.id) return "conflict";
    const [c] = await tx.select().from(socialConnections).where(eq(socialConnections.id, again[0].connectionId));
    return c ?? "conflict";
  }
  return conn;
}

export async function listConnections(ctx: ServiceContext, actor: Actor, filter: { network?: SocialNetwork; status?: string } = {}): Promise<SocialConnection[]> {
  const conds = [eq(socialConnections.workspaceId, actor.workspace.id)];
  if (filter.network) conds.push(eq(socialConnections.network, filter.network));
  if (filter.status) conds.push(eq(socialConnections.status, filter.status));
  const rows = await ctx.db
    .select()
    .from(socialConnections)
    .where(and(...conds))
    .orderBy(desc(socialConnections.createdAt));
  return rows.map((r) => toConnection(r, actor.workspace, ctx.router));
}

export async function getConnection(ctx: ServiceContext, actor: Actor, id: string): Promise<SocialConnection> {
  assertUuid(id, "CONNECTION_NOT_FOUND");
  const { connection } = await getConnectionForWorkspace(ctx.db, actor.workspace.id, id);
  return toConnection(connection, actor.workspace, ctx.router);
}

export async function reconnectConnection(ctx: ServiceContext, actor: Actor, id: string, req: ReconnectRequest): Promise<ConnectionResult> {
  assertUuid(id, "CONNECTION_NOT_FOUND");
  const { connection } = await getConnectionForWorkspace(ctx.db, actor.workspace.id, id);
  return createConnection(
    ctx,
    actor,
    { network: connection.network as SocialNetwork, ...(req.returnUrl ? { returnUrl: req.returnUrl } : {}), ...(req.credentials ? { credentials: req.credentials } : {}) },
    connection,
  );
}

export async function disconnectConnection(ctx: ServiceContext, actor: Actor, id: string): Promise<SocialConnection> {
  assertUuid(id, "CONNECTION_NOT_FOUND");
  const { connection, account } = await getConnectionForWorkspace(ctx.db, actor.workspace.id, id);
  if (connection.status === "disconnected") return toConnection(connection, actor.workspace, ctx.router);
  const provider = ctx.providers.get(connection.provider);
  try {
    await provider.disconnectAccount(account.externalId);
  } catch (err) {
    throw toSocialError(err);
  }
  const now = ctx.now();
  const updated = await ctx.db.transaction(async (tx) => {
    await tx.update(providerAccounts).set({ active: false, updatedAt: now }).where(eq(providerAccounts.id, account.id));
    const [c] = await tx
      .update(socialConnections)
      .set({ status: "disconnected", statusReason: "Disconnected by Zeptly", disconnectedAt: now, updatedAt: now })
      .where(and(eq(socialConnections.id, connection.id), eq(socialConnections.workspaceId, actor.workspace.id)))
      .returning();
    await recordAudit(tx, actor, { workspaceId: actor.workspace.id, action: "connection.removed", resourceType: "connection", resourceId: connection.id, metadata: { network: connection.network } });
    return c ?? connection;
  });
  return toConnection(updated, actor.workspace, ctx.router);
}

/** Canonical transition to reauthorization_required (token expiry webhook or reconciliation). */
export async function markReauthorizationRequired(
  db: Executor,
  actor: Actor | SystemActor,
  connection: SocialConnectionRow,
  reason: string | undefined,
  now: Date,
): Promise<boolean> {
  if (connection.status === "reauthorization_required" || connection.status === "disconnected") return false;
  const updated = await db
    .update(socialConnections)
    .set({ status: "reauthorization_required", statusReason: (reason ?? "Provider credentials expired or were revoked").slice(0, 500), lastCheckedAt: now, updatedAt: now })
    .where(and(eq(socialConnections.id, connection.id), eq(socialConnections.workspaceId, connection.workspaceId)))
    .returning({ id: socialConnections.id });
  if (updated.length === 0) return false;
  await recordAudit(db, actor, { workspaceId: connection.workspaceId, action: "connection.reauthorization_required", resourceType: "connection", resourceId: connection.id, metadata: { network: connection.network } });
  return true;
}

export interface ConnectionReconcileSummary {
  checked: number;
  changed: number;
  adopted: number;
}

/**
 * Connection-health reconciliation. Compares every mapped provider account with
 * the provider's account list:
 *  - inactive at provider                → reauthorization_required
 *  - missing at provider                 → degraded ("not found at provider")
 *  - present+active and currently degraded → connected
 * Adoption (finalize response lost): an unmapped provider account is adopted
 * ONLY if its tenant ref equals the workspace's opaque provider tenant ref AND
 * that workspace has a recent provisioning session for the same network.
 */
export async function reconcileConnections(ctx: ServiceContext, actor: Actor | SystemActor, workspace?: Workspace): Promise<ConnectionReconcileSummary> {
  const summary: ConnectionReconcileSummary = { checked: 0, changed: 0, adopted: 0 };
  for (const providerName of ctx.providers.names()) {
    const provider = ctx.providers.get(providerName);
    let remote: ProviderAccount[];
    try {
      remote = await provider.listAccounts(workspace ? { tenantRef: workspace.providerTenantRef } : {});
    } catch (err) {
      throw toSocialError(err);
    }
    const byId = new Map(remote.map((a) => [a.externalId, a]));
    const now = ctx.now();
    const conds = [eq(providerAccounts.provider, providerName)];
    if (workspace) conds.push(eq(providerAccounts.workspaceId, workspace.id));
    const mapped = await ctx.db
      .select({ connection: socialConnections, account: providerAccounts })
      .from(providerAccounts)
      .innerJoin(socialConnections, eq(socialConnections.id, providerAccounts.connectionId))
      .where(and(...conds));
    const mappedIds = new Set<string>();
    for (const { connection, account } of mapped) {
      mappedIds.add(account.externalId);
      if (connection.status === "disconnected" || connection.workspaceId !== account.workspaceId) continue;
      summary.checked++;
      const r = byId.get(account.externalId);
      // A tenant-filtered listing only proves absence for accounts carrying our tenant ref.
      if (!r && workspace && account.tenantRef !== workspace.providerTenantRef) {
        await ctx.db.update(socialConnections).set({ lastCheckedAt: now }).where(eq(socialConnections.id, connection.id));
        continue;
      }
      let next: { status: string; statusReason: string | null } | undefined;
      if (!r) next = { status: "degraded", statusReason: "Account not found at provider" };
      else if (!r.isActive) next = connection.status === "reauthorization_required" ? undefined : { status: "reauthorization_required", statusReason: "Provider reports the account as inactive" };
      else if (connection.status === "degraded") next = { status: "connected", statusReason: null };
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(socialConnections)
          .set({
            lastCheckedAt: now,
            ...(r ? { displayName: r.displayName ?? r.username ?? connection.displayName, username: r.username ?? connection.username, avatarUrl: r.avatarUrl ?? connection.avatarUrl } : {}),
            ...(next ? { ...next, updatedAt: now } : {}),
          })
          .where(and(eq(socialConnections.id, connection.id), eq(socialConnections.workspaceId, connection.workspaceId)));
        if (next) {
          summary.changed++;
          await recordAudit(tx, actor, {
            workspaceId: connection.workspaceId,
            action: next.status === "reauthorization_required" ? "connection.reauthorization_required" : "connection.reconciled",
            resourceType: "connection",
            resourceId: connection.id,
            metadata: { from: connection.status, to: next.status },
          });
          await recordProviderEvent(tx, {
            workspaceId: connection.workspaceId,
            provider: providerName,
            source: "reconciliation",
            type: "connection.status_changed",
            resourceType: "connection",
            resourceId: connection.id,
            summary: { from: connection.status, to: next.status },
            occurredAt: now,
          });
        }
      });
    }
    // Adoption of unmapped accounts that carry a workspace's tenant ref.
    const unmapped = remote.filter((a) => !mappedIds.has(a.externalId) && a.tenantRef);
    if (unmapped.length === 0) continue;
    const refs = [...new Set(unmapped.map((a) => a.tenantRef as string))];
    const owners = await ctx.db.select().from(workspaces).where(inArray(workspaces.providerTenantRef, refs));
    for (const ws of owners) {
      if (workspace && ws.id !== workspace.id) continue;
      const recent = await ctx.db
        .select()
        .from(provisioningSessions)
        .where(
          and(
            eq(provisioningSessions.workspaceId, ws.id),
            eq(provisioningSessions.provider, providerName),
            gt(provisioningSessions.createdAt, new Date(now.getTime() - ADOPTION_WINDOW_MS)),
            or(eq(provisioningSessions.status, "awaiting_selection"), eq(provisioningSessions.status, "initiated"), eq(provisioningSessions.status, "completed")),
          ),
        );
      for (const a of unmapped.filter((x) => x.tenantRef === ws.providerTenantRef)) {
        const session = recent.find((s) => s.network === a.network);
        if (!session) continue;
        const res = await ctx.db.transaction(async (tx) => adoptAccount(tx, ws, providerName, a.network as SocialNetwork, a, now));
        if (res !== "conflict") {
          summary.adopted++;
          await ctx.db.transaction(async (tx) => {
            if (session.status !== "completed") {
              await tx
                .update(provisioningSessions)
                .set({ status: "completed", connectionIds: [...session.connectionIds, res.id], providerSessionToken: null, completedAt: now, updatedAt: now })
                .where(eq(provisioningSessions.id, session.id));
            }
            await recordAudit(tx, actor, { workspaceId: ws.id, action: "connection.established", resourceType: "connection", resourceId: res.id, metadata: { via: "reconciliation", provisioningId: session.id } });
          });
        }
      }
    }
  }
  return summary;
}

/** Housekeeping: expire stale provisioning sessions and drop their provider session tokens. */
export async function expireProvisioningSessions(db: Executor, now: Date): Promise<void> {
  await db
    .update(provisioningSessions)
    .set({ status: "expired", providerSessionToken: null, updatedAt: now })
    .where(and(or(eq(provisioningSessions.status, "initiated"), eq(provisioningSessions.status, "awaiting_selection")), lt(provisioningSessions.expiresAt, now)));
  await db
    .update(provisioningSessions)
    .set({ providerSessionToken: null })
    .where(and(or(eq(provisioningSessions.status, "completed"), eq(provisioningSessions.status, "failed"), eq(provisioningSessions.status, "expired")), isNull(provisioningSessions.completedAt), lt(provisioningSessions.expiresAt, now)));
}

export type { SocialProvider };
