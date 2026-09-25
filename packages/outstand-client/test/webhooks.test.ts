import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeSignature, parseWebhook, verifySignature } from "../src/webhooks.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/2026-09");
const raw = (name: string) => readFileSync(path.join(dir, name));
const SECRET = "whsec_unit_0123456789";

describe("webhook signature verification", () => {
  const body = raw("webhook-post-published.json");
  const good = computeSignature(SECRET, body);

  it("accepts a valid sha256=<hex> HMAC over the raw bytes", () => {
    expect(good).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(body, good, SECRET)).toBe("valid");
    expect(verifySignature(body, good.toUpperCase().replace("SHA256=", "sha256="), SECRET)).toBe("valid");
  });

  it("rejects missing, malformed, wrong-secret and tampered deliveries", () => {
    expect(verifySignature(body, undefined, SECRET)).toBe("missing");
    expect(verifySignature(body, "", SECRET)).toBe("missing");
    expect(verifySignature(body, good.replace("sha256=", ""), SECRET)).toBe("invalid");
    expect(verifySignature(body, "sha256=abc", SECRET)).toBe("invalid");
    expect(verifySignature(body, computeSignature("other-secret-123456", body), SECRET)).toBe("invalid");
    const tampered = Buffer.from(body.toString().replace("gMPex", "gMPey"));
    expect(verifySignature(tampered, good, SECRET)).toBe("invalid");
  });

  it("verifies bytes, not re-serialized JSON", () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifySignature(reformatted, good, SECRET)).toBe("invalid");
  });

  it("refuses to verify without a secret (fail closed)", () => {
    expect(() => verifySignature(body, good, "")).toThrow();
  });
});

describe("webhook parsing", () => {
  it("post.published → per-account published facts with deterministic event id", () => {
    const p = parseWebhook(raw("webhook-post-published.json"));
    expect(p.type).toBe("post.published");
    expect(p.eventId).toBe("evt:post.published:gMPex:2026-09-23T10:05:00.000Z");
    expect(p.event).toMatchObject({ kind: "post_outcome", providerPostId: "gMPex", accounts: [{ accountExternalId: "WBh2z", outcome: "published", platformPostId: "123_456" }] });
    expect(parseWebhook(raw("webhook-post-published.json")).eventId).toBe(p.eventId);
  });

  it("post.error → failed facts with the provider error", () => {
    const p = parseWebhook(raw("webhook-post-error.json"));
    expect(p.event).toMatchObject({ kind: "post_outcome", accounts: [{ outcome: "failed", error: "Media type not supported" }] });
  });

  it("account.token_expired accepts numeric account ids", () => {
    const p = parseWebhook(raw("webhook-token-expired.json"));
    expect(p.event).toMatchObject({ kind: "account_token_expired", accountExternalId: "12345", reason: "Refresh token revoked" });
  });

  it("test and unknown events are acknowledged without effect", () => {
    expect(parseWebhook(raw("webhook-test.json")).event.kind).toBe("test");
    const unknown = parseWebhook(Buffer.from(JSON.stringify({ event: "import.completed", timestamp: "2026-09-23T10:00:00Z", data: {} })));
    expect(unknown.event.kind).toBe("ignored");
    expect(unknown.eventId).toMatch(/^sha256:/);
  });

  it("message.received → provider-neutral conversation + message", () => {
    const p = parseWebhook(raw("conversation-message-received.json"));
    expect(p.event).toMatchObject({
      kind: "conversation_message",
      accountExternalId: "IGacct",
      conversation: { externalId: "conv_1", participant: { displayName: "Pat Customer" } },
      message: { externalId: "msg_1", direction: "inbound", status: "received", text: "Is this in stock?" },
    });
  });

  it("rejects malformed envelopes", () => {
    expect(() => parseWebhook(Buffer.from("not json"))).toThrow(/not JSON/);
    expect(() => parseWebhook(Buffer.from(JSON.stringify({ event: "post.published", data: {} })))).toThrow(/envelope/);
    expect(() => parseWebhook(Buffer.from(JSON.stringify({ event: "post.published", timestamp: "2026-09-23T10:00:00Z", data: { socialAccounts: [] } })))).toThrow(/data invalid/);
  });
});
