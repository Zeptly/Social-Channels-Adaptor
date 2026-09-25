import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("configuration", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    ZEPTLY_SERVICE_SECRET: "s".repeat(40),
    OUTSTAND_API_KEY: "k",
    OUTSTAND_WEBHOOK_SECRET: "w".repeat(20),
    PUBLIC_BASE_URL: "https://social.example",
  };
  it("fails clearly when mandatory configuration is absent", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ ...base, OUTSTAND_API_KEY: "" });
    } catch (e) {
      expect((e as ConfigError).message).toContain("OUTSTAND_API_KEY");
    }
  });
  it("applies defaults and production guards", () => {
    const c = loadConfig(base);
    expect(c.OUTSTAND_SCHEDULING_HORIZON_DAYS).toBe(30);
    expect(c.port).toBe(8080);
    expect(loadConfig({ ...base, PORT: "3000" }).port).toBe(3000);
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/ALLOWED_RETURN_URL_ORIGINS/);
  });
});
