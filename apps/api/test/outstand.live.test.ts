/**
 * OPT-IN live validation against the real Outstand (PAYG) account.
 * Never runs in normal CI. Enable with:
 *
 *   OUTSTAND_LIVE_TESTS=true OUTSTAND_LIVE_API_KEY=... pnpm test:live
 *
 * Read-only checks run by default. Anything that creates content needs BOTH:
 *   OUTSTAND_LIVE_ALLOW_PUBLISH=true
 *   OUTSTAND_LIVE_TEST_ACCOUNT_ID=<Outstand account id of a DEDICATED test account>
 * and even then only SCHEDULES a post ~25 days ahead and deletes it immediately
 * (no public post is created). Set OUTSTAND_LIVE_PUBLISH_NOW=true in addition to
 * perform a real immediate publish to the dedicated test account.
 */
import { randomUUID } from "node:crypto";
import { OutstandProvider } from "@zeptly-social/provider-outstand";
import { describe, expect, it } from "vitest";

const enabled = process.env.OUTSTAND_LIVE_TESTS === "true" && Boolean(process.env.OUTSTAND_LIVE_API_KEY);
const allowWrite = process.env.OUTSTAND_LIVE_ALLOW_PUBLISH === "true" && Boolean(process.env.OUTSTAND_LIVE_TEST_ACCOUNT_ID);
const suite = enabled ? describe : describe.skip;

suite("LIVE Outstand (opt-in)", () => {
  const provider = new OutstandProvider({
    apiKey: process.env.OUTSTAND_LIVE_API_KEY ?? "unset",
    webhookSecret: process.env.OUTSTAND_WEBHOOK_SECRET ?? "live-suite-unused-secret",
    baseUrl: process.env.OUTSTAND_API_BASE_URL ?? "https://api.outstand.so/v1",
  });

  it("[read-only] accepts the API key", async () => {
    const r = await provider.checkCredentials();
    expect(r.ok).toBe(true);
  });

  it("[read-only] lists accounts in the documented shape (Managed-Key networks)", async () => {
    const accounts = await provider.listAccounts();
    for (const a of accounts) {
      expect(a.externalId).toBeTruthy();
      expect(typeof a.isActive).toBe("boolean");
    }
    process.stdout.write(`live: ${accounts.length} account(s): ${accounts.map((a) => a.network).join(", ")}\n`);
  });

  it("[read-only] can request an auth URL (no account is created)", async () => {
    const r = await provider.initiateConnection({ network: "linkedin", redirectUri: "https://example.com/zeptly-social-live-test", tenantRef: `zs_live_${randomUUID()}` });
    expect(r.authorizationUrl).toMatch(/^https:\/\//);
  });

  (allowWrite ? it : it.skip)("[WRITES to dedicated test account] schedules within the horizon, replays idempotently, then deletes", async () => {
    const account = process.env.OUTSTAND_LIVE_TEST_ACCOUNT_ID as string;
    const key = randomUUID();
    const input = {
      idempotencyKey: key,
      network: "linkedin" as const,
      accountExternalIds: [account],
      text: `Zeptly Social live validation ${new Date().toISOString()} — scheduled and deleted automatically`,
      media: [],
      options: {},
      scheduledAt: new Date(Date.now() + 25 * 86_400_000),
    };
    const first = await provider.schedule(input);
    try {
      expect(first.targets.map((t) => t.accountExternalId)).toContain(account);
      const replay = await provider.schedule(input);
      expect(replay.externalId).toBe(first.externalId);
      const fetched = await provider.getPost(first.externalId);
      expect(fetched.externalId).toBe(first.externalId);
    } finally {
      await provider.deletePost(first.externalId);
    }
  });

  (allowWrite && process.env.OUTSTAND_LIVE_PUBLISH_NOW === "true" ? it : it.skip)("[PUBLISHES publicly to the dedicated test account] immediate publish + metrics", async () => {
    const account = process.env.OUTSTAND_LIVE_TEST_ACCOUNT_ID as string;
    const post = await provider.publish({
      idempotencyKey: randomUUID(),
      network: "linkedin",
      accountExternalIds: [account],
      text: `Zeptly Social live publish test ${new Date().toISOString()}`,
      media: [],
      options: {},
    });
    expect(post.targets[0]?.accountExternalId).toBe(account);
    process.stdout.write(`live: published provider post ${post.externalId}; check webhook delivery and GET /posts/${post.externalId}\n`);
  });
});
