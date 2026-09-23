/**
 * Signed request CLI for operators and validation runs (ZS1-HMAC-SHA256).
 *
 *   ZS_BASE_URL=https://<api-domain> ZEPTLY_SERVICE_SECRET=... ZS_WORKSPACE=ws_test \
 *     pnpm zs GET /v1/connections
 *   pnpm zs POST /v1/posts '{"content":{"text":"hi"},"targets":[{"connectionId":"..."}]}' --idem
 *
 * Flags: --idem (adds a random Idempotency-Key), --no-workspace (admin routes).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

const [method = "GET", path = "/health", body, ...flags] = process.argv.slice(2).filter((a) => a !== "--");
const bodyArg = body?.startsWith("--") ? undefined : body;
const allFlags = [...flags, ...(body?.startsWith("--") ? [body] : [])];
const base = (process.env.ZS_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const secret = process.env.ZEPTLY_SERVICE_SECRET;
if (!secret) {
  process.stderr.write("ZEPTLY_SERVICE_SECRET is required\n");
  process.exit(1);
}
const workspace = allFlags.includes("--no-workspace") ? "" : (process.env.ZS_WORKSPACE ?? "ws_local_test");
const caller = process.env.ZS_CALLER ?? "zeptly-ops-cli";
const agent = process.env.ZS_AGENT ?? "";
const raw = bodyArg ? Buffer.from(JSON.stringify(JSON.parse(bodyArg))) : undefined;
const ts = String(Math.floor(Date.now() / 1000));
const canonical = ["ZS1", ts, method.toUpperCase(), path, workspace, caller, agent, createHash("sha256").update(raw ?? Buffer.alloc(0)).digest("hex")].join("\n");
const headers: Record<string, string> = {
  "x-zeptly-caller": caller,
  "x-zeptly-timestamp": ts,
  "x-zeptly-signature": `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`,
  "x-request-id": randomUUID(),
};
if (workspace) headers["x-zeptly-workspace-id"] = workspace;
if (agent) headers["x-zeptly-agent"] = agent;
if (raw) headers["content-type"] = "application/json";
if (allFlags.includes("--idem")) headers["idempotency-key"] = randomUUID();
const res = await fetch(`${base}${path}`, { method: method.toUpperCase(), headers, ...(raw ? { body: raw } : {}), redirect: "manual" });
const text = await res.text();
process.stdout.write(`${res.status} ${res.headers.get("location") ?? ""}\n`);
try {
  process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
} catch {
  process.stdout.write(`${text}\n`);
}
