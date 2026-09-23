import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redactUrl, registerSecret } from "../src/index.js";

describe("structured logger redaction", () => {
  it("scrubs request URLs, secret-named fields and registered secret values", () => {
    registerSecret("sk_registered_secret_value_123");
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger({ service: "t", level: "info", destination });
    log.info({ req: { method: "GET", url: "/v1/connect/callback/stateTOKEN123?session=sess_abc" } }, "request");
    log.info({ credentials: { handle: "h", appPassword: "pw" }, headers: { authorization: "Bearer abcdefghijklmnop" } }, "creds");
    log.info("using sk_registered_secret_value_123 now");
    log.warn({ err: new Error("failed Bearer abcdefghijklmnopqrstu") }, "boom");
    const out = lines.join("");
    for (const leak of ["stateTOKEN123", "sess_abc", "appPassword\":\"pw", "abcdefghijklmnop", "sk_registered_secret_value_123"]) expect(out).not.toContain(leak);
    expect(out).toContain("[REDACTED]");
  });

  it("redactUrl keeps harmless query parameters", () => {
    expect(redactUrl("/v1/connect/callback/abcDEF123?session=sess_123&x=1")).toBe("/v1/connect/callback/[REDACTED]?session=[REDACTED]&x=1");
    expect(redactUrl("/v1/posts?limit=5")).toBe("/v1/posts?limit=5");
  });
});
