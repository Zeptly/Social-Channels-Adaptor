import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zapp } from "./common.js";

export interface ReadinessProbe {
  /** Must not call providers (spec §27: no excessive provider traffic). */
  check(): Promise<Record<string, { ok: boolean; detail?: string }>>;
}

const Health = z.object({ status: z.literal("ok") }).meta({ id: "Health" });
const Ready = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string().optional() })),
  })
  .meta({ id: "Readiness" });

export function registerHealthRoutes(app: FastifyInstance, probe: ReadinessProbe): void {
  const r = zapp(app);
  r.get("/health", { config: { auth: "public" }, schema: { tags: ["health"], summary: "Liveness", response: { 200: Health } } }, async () => ({ status: "ok" as const }));
  r.get(
    "/ready",
    { config: { auth: "public" }, schema: { tags: ["health"], summary: "Readiness (database + migrations + configuration)", response: { 200: Ready, 503: Ready } } },
    async (_req, reply) => {
      let checks: Record<string, { ok: boolean; detail?: string }>;
      try {
        checks = await probe.check();
      } catch {
        checks = { probe: { ok: false, detail: "readiness probe failed" } };
      }
      const ok = Object.values(checks).every((c) => c.ok);
      return reply.status(ok ? 200 : 503).send({ status: ok ? "ready" : "not_ready", checks });
    },
  );
}
