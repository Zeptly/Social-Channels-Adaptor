import { SocialError, type SocialConversation, type SocialMessage, type SocialNetwork } from "@zeptly-social/domain";
import {
  providerAccounts,
  type SocialConversationRow,
  socialConnections,
  socialConversations,
  socialMessages,
} from "@zeptly-social/database";
import type { ProviderConversation, ProviderMessage } from "@zeptly-social/provider-contract";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import type { Actor, ServiceContext } from "./context.js";
import { toSocialError } from "./provider-errors.js";
import { toConversation, toMessage } from "./serializers.js";
import { assertUuid, type ConnectionWithAccount, getConnectionForWorkspace } from "./tenancy.js";

/**
 * Provider-neutral conversations. Capability-gated: networks that do not
 * support conversations (every V1 network except Instagram DMs) get a
 * structured CAPABILITY_NOT_SUPPORTED error rather than an attempted call.
 */

function assertConversations(ctx: ServiceContext, c: ConnectionWithAccount, capability: "conversations" | "directMessages" = "conversations"): void {
  ctx.router.assert(c.connection.provider, c.connection.network as SocialNetwork, capability);
}

export async function listConversations(
  ctx: ServiceContext,
  actor: Actor,
  q: { connectionId?: string; limit: number; cursor?: string },
): Promise<{ data: SocialConversation[]; nextCursor?: string }> {
  const ws = actor.workspace;
  const conds = [eq(socialConversations.workspaceId, ws.id)];
  if (q.connectionId) {
    assertUuid(q.connectionId, "CONNECTION_NOT_FOUND");
    const c = await getConnectionForWorkspace(ctx.db, ws.id, q.connectionId);
    assertConversations(ctx, c);
    conds.push(eq(socialConversations.connectionId, c.connection.id));
  }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, "base64url").toString().split("|");
    const d = new Date(ts ?? "");
    if (!id || Number.isNaN(d.getTime())) throw new SocialError("VALIDATION_ERROR", "Invalid cursor");
    const c = or(lt(socialConversations.updatedAt, d), and(eq(socialConversations.updatedAt, d), lt(socialConversations.id, id)));
    if (c) conds.push(c);
  }
  const rows = await ctx.db
    .select()
    .from(socialConversations)
    .where(and(...conds))
    .orderBy(desc(socialConversations.updatedAt), desc(socialConversations.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((r) => toConversation(r, ws)),
    ...(rows.length > q.limit && last ? { nextCursor: Buffer.from(`${last.updatedAt.toISOString()}|${last.id}`).toString("base64url") } : {}),
  };
}

async function loadConversation(ctx: ServiceContext, actor: Actor, id: string): Promise<{ conv: SocialConversationRow; conn: ConnectionWithAccount }> {
  assertUuid(id, "CONVERSATION_NOT_FOUND");
  const [conv] = await ctx.db
    .select()
    .from(socialConversations)
    .where(and(eq(socialConversations.id, id), eq(socialConversations.workspaceId, actor.workspace.id)))
    .limit(1);
  if (!conv) throw new SocialError("CONVERSATION_NOT_FOUND", "Conversation not found");
  const conn = await getConnectionForWorkspace(ctx.db, actor.workspace.id, conv.connectionId);
  return { conv, conn };
}

export async function getConversation(ctx: ServiceContext, actor: Actor, id: string): Promise<SocialConversation> {
  const { conv, conn } = await loadConversation(ctx, actor, id);
  assertConversations(ctx, conn);
  return toConversation(conv, actor.workspace);
}

export async function listMessages(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  q: { limit: number; cursor?: string; refresh?: boolean },
): Promise<{ data: SocialMessage[]; nextCursor?: string }> {
  const { conv, conn } = await loadConversation(ctx, actor, id);
  assertConversations(ctx, conn);
  if (q.refresh) await refreshMessages(ctx, conn, conv);
  const conds = [eq(socialMessages.conversationId, conv.id), eq(socialMessages.workspaceId, actor.workspace.id)];
  if (q.cursor) {
    const [ts, mid] = Buffer.from(q.cursor, "base64url").toString().split("|");
    const d = new Date(ts ?? "");
    if (!mid || Number.isNaN(d.getTime())) throw new SocialError("VALIDATION_ERROR", "Invalid cursor");
    const c = or(lt(socialMessages.createdAt, d), and(eq(socialMessages.createdAt, d), lt(socialMessages.id, mid)));
    if (c) conds.push(c);
  }
  const rows = await ctx.db
    .select()
    .from(socialMessages)
    .where(and(...conds))
    .orderBy(desc(socialMessages.createdAt), desc(socialMessages.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toMessage),
    ...(rows.length > q.limit && last ? { nextCursor: Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url") } : {}),
  };
}

async function refreshMessages(ctx: ServiceContext, conn: ConnectionWithAccount, conv: SocialConversationRow): Promise<void> {
  const provider = ctx.providers.get(conn.connection.provider);
  if (!provider.listMessages) return;
  try {
    const page = await provider.listMessages({ conversationExternalId: conv.externalId });
    for (const m of page.items) await upsertMessage(ctx, conv, m);
  } catch (err) {
    throw toSocialError(err);
  }
}

/** POST /v1/conversations/:id/messages — idempotent on (conversation, Idempotency-Key). */
export async function sendMessage(ctx: ServiceContext, actor: Actor, id: string, text: string, idempotencyKey: string): Promise<{ message: SocialMessage; replayed: boolean }> {
  const { conv, conn } = await loadConversation(ctx, actor, id);
  assertConversations(ctx, conn, "directMessages");
  if (conn.connection.status === "reauthorization_required") throw new SocialError("REAUTHORIZATION_REQUIRED", "The connection must be reauthorized");
  if (conn.connection.status !== "connected" && conn.connection.status !== "degraded") throw new SocialError("CONNECTION_NOT_ACTIVE", "The connection is not active");
  const provider = ctx.providers.get(conn.connection.provider);
  if (!provider.sendMessage) throw new SocialError("CAPABILITY_NOT_SUPPORTED", "Sending messages is not supported by this provider");

  const inserted = await ctx.db
    .insert(socialMessages)
    .values({ workspaceId: actor.workspace.id, conversationId: conv.id, direction: "outbound", status: "sending", text, idempotencyKey, createdBy: actor.agent ?? actor.service })
    .onConflictDoNothing()
    .returning();
  let row = inserted[0];
  if (!row) {
    const [existing] = await ctx.db.select().from(socialMessages).where(and(eq(socialMessages.conversationId, conv.id), eq(socialMessages.idempotencyKey, idempotencyKey))).limit(1);
    if (!existing) throw new SocialError("INTERNAL_ERROR", "Message idempotency lookup failed");
    if (existing.text !== text) throw new SocialError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different message");
    if (existing.status !== "sending" || existing.createdAt.getTime() > ctx.now().getTime() - 60_000) return { message: toMessage(existing), replayed: true };
    row = existing; // stale "sending": retry with the same provider key
  }
  // Provider key derived from our message id → provider-side dedupe across retries.
  const providerKey = row.id;
  try {
    const sent = await provider.sendMessage({ conversationExternalId: conv.externalId, text, idempotencyKey: providerKey });
    const [updated] = await ctx.db
      .update(socialMessages)
      .set({ status: sent.status === "failed" ? "failed" : "sent", externalId: sent.externalId, sentAt: sent.sentAt ?? ctx.now(), updatedAt: ctx.now() })
      .where(eq(socialMessages.id, row.id))
      .returning();
    await ctx.db.update(socialConversations).set({ lastMessageAt: sent.sentAt ?? ctx.now(), lastMessagePreview: text.slice(0, 280), updatedAt: ctx.now() }).where(eq(socialConversations.id, conv.id));
    await recordAudit(ctx.db, actor, { workspaceId: actor.workspace.id, action: "message.sent", resourceType: "conversation", resourceId: conv.id, metadata: { messageId: row.id } });
    return { message: toMessage(updated ?? row), replayed: false };
  } catch (err) {
    const se = toSocialError(err);
    if (!se.retryable) {
      await ctx.db.update(socialMessages).set({ status: "failed", errorCode: se.code, errorMessage: se.message, updatedAt: ctx.now() }).where(eq(socialMessages.id, row.id));
      await recordAudit(ctx.db, actor, { workspaceId: actor.workspace.id, action: "message.failed", resourceType: "conversation", resourceId: conv.id, metadata: { messageId: row.id, code: se.code } });
    }
    throw se;
  }
}

/** Upsert a provider conversation (and messages) for an already-resolved workspace mapping. */
export async function upsertConversationFromProvider(ctx: ServiceContext, mapping: ConnectionWithAccount, pc: ProviderConversation, messages: ProviderMessage[]): Promise<SocialConversationRow | undefined> {
  const { connection } = mapping;
  const now = ctx.now();
  const participant = {
    ...(pc.participant.displayName ? { displayName: pc.participant.displayName } : {}),
    ...(pc.participant.username ? { username: pc.participant.username } : {}),
    ...(pc.participant.avatarUrl ? { avatarUrl: pc.participant.avatarUrl } : {}),
    ...(pc.participant.externalId ? { externalId: pc.participant.externalId } : {}),
  };
  const [existing] = await ctx.db
    .select()
    .from(socialConversations)
    .where(and(eq(socialConversations.provider, connection.provider), eq(socialConversations.externalId, pc.externalId)))
    .limit(1);
  let conv: SocialConversationRow | undefined;
  if (existing) {
    // Never let a provider reference move a conversation across workspaces/connections.
    if (existing.workspaceId !== connection.workspaceId || existing.connectionId !== connection.id) {
      ctx.logger.warn({ conversationId: existing.id }, "conversation ownership mismatch; event ignored");
      return undefined;
    }
    const hasProfile = Object.keys(participant).length > 0;
    [conv] = await ctx.db
      .update(socialConversations)
      .set({
        ...(hasProfile ? { participant: { ...existing.participant, ...participant } } : {}),
        ...(pc.lastMessageAt && (!existing.lastMessageAt || pc.lastMessageAt > existing.lastMessageAt) ? { lastMessageAt: pc.lastMessageAt } : {}),
        ...(pc.lastMessagePreview ? { lastMessagePreview: pc.lastMessagePreview } : {}),
        updatedAt: now,
      })
      .where(eq(socialConversations.id, existing.id))
      .returning();
  } else {
    const ins = await ctx.db
      .insert(socialConversations)
      .values({
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        provider: connection.provider,
        externalId: pc.externalId,
        network: connection.network,
        participant,
        lastMessageAt: pc.lastMessageAt ?? null,
        lastMessagePreview: pc.lastMessagePreview ?? null,
      })
      .onConflictDoNothing()
      .returning();
    conv = ins[0];
    if (!conv) return upsertConversationFromProvider(ctx, mapping, pc, messages);
  }
  if (!conv) return undefined;
  for (const m of messages) await upsertMessage(ctx, conv, m);
  return conv;
}

async function upsertMessage(ctx: ServiceContext, conv: SocialConversationRow, m: ProviderMessage): Promise<void> {
  const values = {
    workspaceId: conv.workspaceId,
    conversationId: conv.id,
    externalId: m.externalId,
    direction: m.direction,
    status: m.status,
    text: m.text ?? null,
    attachments: m.attachments,
    sentAt: m.sentAt ?? null,
    errorCode: m.status === "failed" ? "PUBLICATION_FAILED" : null,
    errorMessage: m.error ?? null,
  };
  await ctx.db
    .insert(socialMessages)
    .values(values)
    .onConflictDoUpdate({
      target: [socialMessages.conversationId, socialMessages.externalId],
      set: { status: sql`excluded.status`, errorMessage: sql`excluded.error_message`, updatedAt: ctx.now() },
    });
  if (m.sentAt && (!conv.lastMessageAt || m.sentAt > conv.lastMessageAt)) {
    await ctx.db
      .update(socialConversations)
      .set({ lastMessageAt: m.sentAt, ...(m.text ? { lastMessagePreview: m.text.slice(0, 280) } : {}), updatedAt: ctx.now() })
      .where(eq(socialConversations.id, conv.id));
    conv.lastMessageAt = m.sentAt;
  }
}

/** Worker: pull conversations for every connected account on a conversation-capable network. */
export async function syncConversations(ctx: ServiceContext): Promise<number> {
  const rows = await ctx.db
    .select({ connection: socialConnections, account: providerAccounts })
    .from(socialConnections)
    .innerJoin(providerAccounts, eq(providerAccounts.connectionId, socialConnections.id))
    .where(and(inArray(socialConnections.status, ["connected", "degraded"]), eq(providerAccounts.active, true)));
  let synced = 0;
  for (const mapping of rows) {
    if (mapping.account.workspaceId !== mapping.connection.workspaceId) continue;
    if (!ctx.router.supports(mapping.connection.provider, mapping.connection.network as SocialNetwork, "conversations")) continue;
    const provider = ctx.providers.get(mapping.connection.provider);
    if (!provider.listConversations) continue;
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 4; pageNo++) {
      const page = await provider.listConversations({ accountExternalId: mapping.account.externalId, ...(cursor ? { cursor } : {}) });
      for (const pc of page.items) {
        const [before] = await ctx.db
          .select({ lastMessageAt: socialConversations.lastMessageAt })
          .from(socialConversations)
          .where(and(eq(socialConversations.provider, mapping.connection.provider), eq(socialConversations.externalId, pc.externalId)))
          .limit(1);
        const conv = await upsertConversationFromProvider(ctx, mapping, pc, []);
        if (!conv) continue;
        synced++;
        const stale = !before?.lastMessageAt || (pc.lastMessageAt && pc.lastMessageAt > before.lastMessageAt);
        if (stale && provider.listMessages) {
          const msgs = await provider.listMessages({ conversationExternalId: pc.externalId });
          for (const m of msgs.items) await upsertMessage(ctx, conv, m);
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }
  return synced;
}

