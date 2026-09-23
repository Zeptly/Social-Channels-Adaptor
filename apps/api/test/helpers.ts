import { createServiceContext, loadConfig, type ServiceContext } from "@zeptly-social/core";
import type { DatabaseHandle } from "@zeptly-social/database";
import {
  FakeOutstand,
  openTestDatabase,
  resetDatabase,
  silentLogger,
  TEST_OUTSTAND_KEY,
  TEST_RETURN_ORIGIN,
  TEST_SERVICE_SECRET,
  TEST_WEBHOOK_SECRET,
  TestClock,
  testEnv,
} from "@zeptly-social/test-utils";
import { OutstandProvider } from "@zeptly-social/provider-outstand";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { HmacServiceAuthenticator, signRequest } from "../src/auth.js";
import { Worker } from "../../worker/src/runtime.js";

export interface Harness {
  app: FastifyInstance;
  ctx: ServiceContext;
  fake: FakeOutstand;
  db: DatabaseHandle;
  clock: TestClock;
  call(
    workspace: string | null,
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: any; headers: Record<string, unknown> }>;
  connect(workspace: string, network: string, pages?: Array<{ name: string; type?: "personal" | "organization" }>): Promise<any[]>;
  /** Run worker ticks until no job is claimed. */
  drain(maxTicks?: number): Promise<number>;
  webhook(event: string, data: Record<string, unknown>, opts?: { secret?: string; timestamp?: string }): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
}

let shared: DatabaseHandle | undefined;

export async function createHarness(opts: { inlineDispatch?: boolean; now?: Date } = {}): Promise<Harness> {
  shared ??= await openTestDatabase();
  const db = shared;
  await resetDatabase(db);
  const clock = new TestClock(opts.now?.getTime() ?? Date.now());
  const fake = new FakeOutstand(TEST_OUTSTAND_KEY);
  fake.now = clock.now;
  const logger = silentLogger();
  const config = loadConfig(testEnv());
  const provider = new OutstandProvider({
    apiKey: TEST_OUTSTAND_KEY,
    webhookSecret: TEST_WEBHOOK_SECRET,
    baseUrl: config.OUTSTAND_API_BASE_URL,
    fetchImpl: fake.fetch,
    retryBaseMs: 1,
    maxAttempts: 3,
    logger,
  });
  const ctx = createServiceContext({ config, db: db.db, logger, providers: [provider], inlineDispatch: opts.inlineDispatch ?? true, now: clock.now, skipMediaDnsCheck: true });
  const app = await buildApp({
    ctx,
    authenticator: new HmacServiceAuthenticator(TEST_SERVICE_SECRET, undefined, () => clock.now().getTime()),
    logger: false,
    readiness: { check: async () => ({ database: { ok: true } }) },
  });
  await app.ready();

  const call: Harness["call"] = async (workspace, method, url, body, headers = {}) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(clock.now().getTime() / 1000));
    const sig = signRequest(TEST_SERVICE_SECRET, { timestamp: ts, method, url, workspaceId: workspace ?? "", caller: "zeptly-app", agent: headers["x-zeptly-agent"] ?? "", body: raw });
    const res = await app.inject({
      method,
      url,
      headers: {
        "x-zeptly-caller": "zeptly-app",
        "x-zeptly-timestamp": ts,
        "x-zeptly-signature": sig,
        ...(workspace ? { "x-zeptly-workspace-id": workspace } : {}),
        ...(raw ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(raw ? { payload: raw } : {}),
    });
    let json: unknown;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json, headers: res.headers };
  };

  const connect: Harness["connect"] = async (workspace, network, pages = [{ name: `${network} page` }]) => {
    const init = await call(workspace, "POST", "/v1/connections", { network, returnUrl: `${TEST_RETURN_ORIGIN}/social/return` });
    if (init.status !== 201) throw new Error(`connect init failed: ${JSON.stringify(init.json)}`);
    const { callbackUrl } = fake.authorize(init.json.provisioning.authorizationUrl, pages);
    const cb = new URL(callbackUrl);
    const res = await app.inject({ method: "GET", url: cb.pathname + cb.search });
    if (res.statusCode !== 303) throw new Error(`callback failed ${res.statusCode} ${res.body}`);
    const back = new URL(res.headers.location as string);
    const provisioningId = back.searchParams.get("provisioningId") as string;
    if (back.searchParams.get("status") === "awaiting_selection") {
      const p = await call(workspace, "GET", `/v1/provisioning/${provisioningId}`);
      const fin = await call(workspace, "POST", `/v1/provisioning/${provisioningId}/finalize`, { optionIds: p.json.options.map((o: { id: string }) => o.id) });
      if (fin.status !== 200) throw new Error(`finalize failed ${JSON.stringify(fin.json)}`);
      return fin.json.connections;
    }
    const list = await call(workspace, "GET", "/v1/connections");
    return list.json.data.filter((c: { network: string }) => c.network === network);
  };

  const webhook: Harness["webhook"] = async (event, data, o = {}) => {
    const { body, signature } = fake.signWebhook(o.secret ?? TEST_WEBHOOK_SECRET, event, data, o.timestamp);
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/outstand", headers: { "content-type": "application/json", "x-outstand-signature": signature }, payload: body });
    return { status: res.statusCode, json: res.json() };
  };

  const worker = new Worker(ctx, { concurrency: 8, pollIntervalMs: 10, workerId: "test-worker" });
  const drain: Harness["drain"] = async (maxTicks = 20) => {
    let total = 0;
    for (let i = 0; i < maxTicks; i++) {
      const r = await worker.tick();
      total += r.jobs;
      if (r.jobs === 0) break;
    }
    return total;
  };

  return { app, ctx, fake, db, clock, call, connect, webhook, drain, close: () => app.close() };
}

export const idem = () => randomUUID();
