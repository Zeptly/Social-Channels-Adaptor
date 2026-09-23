import { SocialError } from "@zeptly-social/domain";
import { idempotencyKeys } from "@zeptly-social/database";
import { and, eq, lt } from "drizzle-orm";
import type { Actor, ServiceContext } from "./context.js";
import { requestHash } from "./posts.js";

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function assertIdempotencyKey(key: string | undefined): string {
  if (!key) throw new SocialError("IDEMPOTENCY_KEY_REQUIRED", "The Idempotency-Key header is required for this operation");
  if (!KEY_PATTERN.test(key)) throw new SocialError("VALIDATION_ERROR", "Idempotency-Key must be 8-128 characters of [A-Za-z0-9._:-]");
  return key;
}

export interface StoredResponse<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * API-level idempotency for mutating commands (publish/schedule/cancel/etc.).
 * Same key + same request → the stored response is replayed. Same key with a
 * different request → IDEMPOTENCY_CONFLICT. Concurrent duplicate while the
 * first is in flight → retryable IDEMPOTENCY_CONFLICT. Failed executions release
 * the key so the caller can retry (the underlying operations are themselves
 * state-idempotent).
 */
export async function withIdempotency<T>(
  ctx: ServiceContext,
  actor: Actor,
  operation: string,
  key: string,
  request: unknown,
  run: () => Promise<{ status: number; body: T }>,
): Promise<StoredResponse<T>> {
  const hash = requestHash({ operation, request });
  const now = ctx.now();
  const ws = actor.workspace.id;
  const inserted = await ctx.db
    .insert(idempotencyKeys)
    .values({ workspaceId: ws, key, operation, requestHash: hash, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });
  if (!inserted[0]) {
    const [existing] = await ctx.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.workspaceId, ws), eq(idempotencyKeys.operation, operation), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!existing) throw new SocialError("IDEMPOTENCY_CONFLICT", "Idempotency key state changed concurrently; retry", { retryable: true });
    if (existing.expiresAt < now) {
      await ctx.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
      return withIdempotency(ctx, actor, operation, key, request, run);
    }
    if (existing.requestHash !== hash) throw new SocialError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request");
    if (existing.responseStatus === null) throw new SocialError("IDEMPOTENCY_CONFLICT", "A request with this Idempotency-Key is still in progress", { retryable: true });
    return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
  }
  const id = inserted[0].id;
  try {
    const res = await run();
    await ctx.db.update(idempotencyKeys).set({ responseStatus: res.status, responseBody: res.body }).where(eq(idempotencyKeys.id, id));
    return { ...res, replayed: false };
  } catch (err) {
    await ctx.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
    throw err;
  }
}

export async function purgeExpiredIdempotencyKeys(ctx: ServiceContext): Promise<void> {
  await ctx.db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, ctx.now()));
}
