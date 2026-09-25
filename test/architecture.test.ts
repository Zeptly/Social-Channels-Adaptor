/**
 * Static architecture rules for the Outstand Gateway (spec: architecture-level
 * tests). They read import specifiers from source files, so a violation fails
 * CI before any behaviour test runs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string): string[] {
  const abs = path.join(root, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = path.join(abs, name);
    if (statSync(p).isDirectory()) out.push(...files(path.relative(root, p)));
    else if (name.endsWith(".ts")) out.push(path.relative(root, p));
  }
  return out;
}

const IMPORT = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm;
function importsOf(file: string): string[] {
  const src = readFileSync(path.join(root, file), "utf8");
  return [...src.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}
const external = (spec: string) => !spec.startsWith(".") && !spec.startsWith("node:");

function violations(dir: string, allowed: (spec: string, file: string) => boolean): string[] {
  return files(dir).flatMap((f) => importsOf(f).filter((s) => !allowed(s, f)).map((s) => `${f} → ${s}`));
}

describe("dependency direction", () => {
  it("Gateway Contract v1 depends only on zod", () => {
    expect(violations("packages/gateway-contract/src", (s) => !external(s) || s === "zod")).toEqual([]);
  });

  it("Social Publishing Contract v1 depends only on zod and the Gateway Contract", () => {
    expect(violations("packages/adapters/social-publishing/src/contract", (s) => s.startsWith("./") || s === "zod" || s === "@zeptly-gateway/gateway-contract")).toEqual([]);
  });

  it("capability contracts (analytics, direct messages) depend only on zod, the Gateway Contract and the publishing contract", () => {
    const ok = (s: string) => s.startsWith("./") || ["zod", "@zeptly-gateway/gateway-contract", "@zeptly-gateway/social-publishing/contract"].includes(s);
    for (const f of ["packages/adapters/social-analytics/src/contract.ts", "packages/adapters/social-direct-messages/src/contract.ts"]) {
      expect(importsOf(f).filter((s) => !ok(s))).toEqual([]);
    }
  });

  it("gateway-core knows no provider and no capability domain", () => {
    const forbidden = /^@zeptly-gateway\/(outstand-client|outstand-gateway|social-)/;
    expect(violations("packages/gateway-core/src", (s) => !forbidden.test(s))).toEqual([]);
  });

  it("the Outstand client depends on no gateway or capability package beyond the contract", () => {
    const ok = (s: string) => !s.startsWith("@zeptly-gateway/") || ["@zeptly-gateway/gateway-contract", "@zeptly-gateway/observability"].includes(s);
    expect(violations("packages/outstand-client/src", ok)).toEqual([]);
  });
});

describe("Outstand isolation", () => {
  const OUTSTAND = /^@zeptly-gateway\/outstand-client(\/|$)/;

  it("only the composition root and adapters/*/src/outstand import the Outstand client", () => {
    const sources = [...files("packages"), ...files("apps")].filter((f) => f.includes("/src/"));
    const offenders = sources.filter(
      (f) =>
        !f.startsWith("packages/outstand-client/") &&
        !f.startsWith("packages/outstand-gateway/") &&
        !/^packages\/adapters\/[^/]+\/src\/outstand\//.test(f) &&
        importsOf(f).some((s) => OUTSTAND.test(s)),
    );
    expect(offenders).toEqual([]);
  });

  it("canonical capability services never import provider adapters", () => {
    for (const pkg of ["social-publishing", "social-analytics", "social-direct-messages"]) {
      const dir = `packages/adapters/${pkg}/src`;
      const offenders = files(dir)
        .filter((f) => !f.includes("/src/outstand/"))
        .flatMap((f) => importsOf(f).filter((s) => OUTSTAND.test(s) || /\/outstand(\/|\.js|$)/.test(s)).map((s) => `${f} → ${s}`));
      expect(offenders).toEqual([]);
    }
  });

  it("Outstand wire schemas are private to the client", () => {
    expect(importsOf("packages/outstand-client/src/index.ts").filter((s) => /wire/.test(s))).toEqual([]);
    const outside = [...files("packages"), ...files("apps")].filter((f) => !f.startsWith("packages/outstand-client/") && importsOf(f).some((s) => /wire(\.js)?$/.test(s)));
    expect(outside).toEqual([]);
  });

  it("no package reaches into another package's internals", () => {
    const deep = [...files("packages"), ...files("apps"), ...files("test")].flatMap((f) => importsOf(f).filter((s) => /^@zeptly-gateway\/[^/]+\/src\//.test(s)).map((s) => `${f} → ${s}`));
    expect(deep).toEqual([]);
  });
});

describe("no cross-provider routing", () => {
  it("the removed router, provider registry and per-request provider selection do not come back", () => {
    const src = [...files("packages"), ...files("apps")].filter((f) => f.includes("/src/")).map((f) => readFileSync(path.join(root, f), "utf8")).join("\n");
    expect(src).not.toMatch(/CapabilityRouter|ProviderRegistry|providers\.get\(|router\.resolve/);
  });
});
