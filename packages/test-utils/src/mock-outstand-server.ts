/**
 * Local development stand-in for Outstand (no Outstand account required).
 *
 *   pnpm dev:mock-outstand          # listens on :4010
 *   OUTSTAND_API_BASE_URL=http://localhost:4010/v1 OUTSTAND_API_KEY=dev-outstand-key pnpm dev
 *
 * GET /authorize?state_token=… simulates the provider-hosted consent screen:
 * it creates two selectable pages and redirects the browser to the service's
 * callback exactly like Outstand does. POST /_control/publish/:postId marks a
 * post published and delivers a signed post.published webhook to WEBHOOK_TARGET.
 */
import Fastify from "fastify";
import { FAKE_BASE, FakeOutstand } from "./fake-outstand.js";

const port = Number(process.env.MOCK_OUTSTAND_PORT ?? 4010);
const apiKey = process.env.OUTSTAND_API_KEY ?? "dev-outstand-key";
const webhookSecret = process.env.OUTSTAND_WEBHOOK_SECRET ?? "dev-webhook-secret-0123456789";
const webhookTarget = process.env.WEBHOOK_TARGET ?? "http://localhost:8080/v1/webhooks/outstand";
const fake = new FakeOutstand(apiKey);
const localBase = `http://localhost:${port}`;

const app = Fastify({ logger: { level: "info" } });
app.removeAllContentTypeParsers();
app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

app.get("/authorize", async (req, reply) => {
  const url = new URL(req.url, localBase);
  const { callbackUrl } = fake.authorize(url.toString().replace(localBase, "https://fake.outstand.test"), [
    { name: "Acme Page", type: "organization" },
    { name: "Acme Personal", type: "personal" },
  ]);
  return reply.redirect(callbackUrl, 302);
});

app.post("/_control/publish/:postId", async (req) => {
  const { postId } = req.params as { postId: string };
  fake.publishAll(postId);
  const post = fake.posts.get(postId);
  const { body, signature } = fake.signWebhook(webhookSecret, "post.published", {
    postId,
    orgId: "org_1",
    socialAccounts: (post?.accounts ?? []).map((a) => ({ accountId: a.id, platformPostId: a.platformPostId, platformPostUrl: a.platformPostUrl })),
  });
  const res = await fetch(webhookTarget, { method: "POST", headers: { "content-type": "application/json", "x-outstand-signature": signature }, body });
  return { delivered: res.status };
});

app.all("/v1/*", async (req, reply) => {
  const target = `${FAKE_BASE}${req.url.replace(/^\/v1/, "")}`;
  const body = req.body instanceof Buffer && req.body.length ? req.body.toString("utf8") : undefined;
  const res = await fake.fetch(target, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) });
  const text = (await res.text()).replaceAll("https://fake.outstand.test/authorize", `${localBase}/authorize`);
  reply.status(res.status);
  res.headers.forEach((v, k) => {
    if (k !== "content-length") reply.header(k, v);
  });
  return reply.send(text);
});

await app.listen({ port, host: "0.0.0.0" });
