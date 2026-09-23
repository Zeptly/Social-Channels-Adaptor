import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, idem } from "./helpers.js";

const WS = "ws_edit";
const DAY = 86_400_000;
let h: Harness;
afterEach(async () => {
  await h.close();
});

async function scheduledPost(h: Harness, days: number, pages = [{ name: "A" }]) {
  const conns = await h.connect(WS, "linkedin", pages);
  const p = await h.call(WS, "POST", "/v1/posts", { content: { text: "v1 copy" }, targets: conns.map((c: { id: string }) => ({ connectionId: c.id })) }, { "idempotency-key": idem() });
  const at = new Date(h.clock.now().getTime() + days * DAY);
  await h.call(WS, "POST", `/v1/posts/${p.json.id}/schedule`, { scheduledAt: at.toISOString() }, { "idempotency-key": idem() });
  return { post: p.json, conns, at };
}

const patch = (id: string, body: unknown, key = idem()) => h.call(WS, "PATCH", `/v1/posts/${id}`, body, { "idempotency-key": key });

describe("editing posts (same post id)", () => {
  it("edits a draft's copy and target list", async () => {
    h = await createHarness();
    const [li] = await h.connect(WS, "linkedin");
    const [th] = await h.connect(WS, "threads", [{ name: "T" }]);
    const p = await h.call(WS, "POST", "/v1/posts", { content: { text: "draft" }, targets: [{ connectionId: li.id }] }, { "idempotency-key": idem() });
    const r = await patch(p.json.id, { content: { text: "edited" }, targets: [{ connectionId: th.id, options: { replyControl: "everyone" } }] });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(p.json.id);
    expect(r.json.content.text).toBe("edited");
    expect(r.json.targets.map((t: { network: string }) => t.network)).toEqual(["threads"]);
    const bad = await patch(p.json.id, { content: { text: "x".repeat(600) } });
    expect(bad.json.error.code).toBe("VALIDATION_ERROR");
  });

  it("re-plans a scheduled post that has not been handed off yet", async () => {
    h = await createHarness();
    const { post, at } = await scheduledPost(h, 60);
    const r = await patch(post.id, { content: { text: "v2 copy" } });
    expect(r.json).toMatchObject({ id: post.id, status: "scheduled", scheduledAt: at.toISOString(), content: { text: "v2 copy" } });
    const pubs = await h.call(WS, "GET", `/v1/posts/${post.id}/publications`);
    expect(pubs.json.data.map((p: { status: string }) => p.status)).toEqual(["cancelled", "pending"]);
    expect(h.fake.posts.size).toBe(0);
    h.clock.advance(31 * DAY);
    await h.drain();
    expect((h.fake.lastPost()?.body.containers as Array<{ content: string }>)[0]?.content).toBe("v2 copy");
  });

  it("without provider update support, a handed-off post is deleted and recreated", async () => {
    h = await createHarness({ postUpdate: false });
    const { post } = await scheduledPost(h, 3);
    const first = h.fake.lastPost();
    await patch(post.id, { content: { text: "v2 copy" } });
    expect(h.fake.posts.get(first?.id as string)?.deleted).toBe(true);
    expect(h.fake.posts.size).toBe(2);
    expect(h.fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("with Outstand post update enabled, edits and reschedules in place keeping the provider reference", async () => {
    h = await createHarness({ postUpdate: true });
    const { post } = await scheduledPost(h, 3);
    const remote = h.fake.lastPost();
    await patch(post.id, { content: { text: "v2 copy" } });
    const later = new Date(h.clock.now().getTime() + 10 * DAY);
    const rs = await h.call(WS, "POST", `/v1/posts/${post.id}/schedule`, { scheduledAt: later.toISOString() }, { "idempotency-key": idem() });
    expect(rs.json.status).toBe("scheduled");
    expect(h.fake.posts.size).toBe(1);
    expect(h.fake.posts.get(remote?.id as string)).toMatchObject({ deleted: false, scheduledAt: later.toISOString() });
    const patches = h.fake.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[0]?.body).not.toHaveProperty("accounts");
    expect((patches[0]?.body as { containers: Array<{ content: string }> }).containers[0]?.content).toBe("v2 copy");
    const pubs = await h.call(WS, "GET", `/v1/posts/${post.id}/publications`);
    expect(pubs.json.data.map((p: { status: string }) => p.status)).toEqual(["accepted"]);
    const audit = await h.db.pool.query("select count(*)::int as n from audit_events where action = 'publication.updated_in_place'");
    expect(audit.rows[0].n).toBe(2);
  });

  it("falls back to delete + recreate when the in-place update fails or leaves the horizon", async () => {
    h = await createHarness({ postUpdate: true });
    const { post } = await scheduledPost(h, 3);
    const remote = h.fake.lastPost();
    h.fake.fail("PATCH", "/posts/", { status: 400, body: { success: false, error: "not editable" } });
    await patch(post.id, { content: { text: "v2 copy" } });
    expect(h.fake.posts.get(remote?.id as string)?.deleted).toBe(true);
    const second = h.fake.lastPost();
    // Moving beyond the 30-day horizon cannot stay at the provider: deleted, kept locally.
    await h.call(WS, "POST", `/v1/posts/${post.id}/schedule`, { scheduledAt: new Date(h.clock.now().getTime() + 45 * DAY).toISOString() }, { "idempotency-key": idem() });
    expect(h.fake.posts.get(second?.id as string)?.deleted).toBe(true);
    const pubs = await h.call(WS, "GET", `/v1/posts/${post.id}/publications`);
    expect(pubs.json.data.at(-1).status).toBe("pending");
  });

  it("refuses edits once a target is published", async () => {
    h = await createHarness();
    const [c] = await h.connect(WS, "linkedin");
    const p = await h.call(WS, "POST", "/v1/posts", { content: { text: "now" }, targets: [{ connectionId: c.id }] }, { "idempotency-key": idem() });
    await h.call(WS, "POST", `/v1/posts/${p.json.id}/publish`, undefined, { "idempotency-key": idem() });
    const r = await patch(p.json.id, { content: { text: "too late" } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("INVALID_STATE");
  });
});

describe("new verified network options", () => {
  it("Facebook Reels/Stories: validated and mapped to the facebook configuration override", async () => {
    h = await createHarness();
    const [fb] = await h.connect(WS, "facebook", [{ name: "Page" }]);
    const vid = await h.call(WS, "POST", "/v1/media", { source: { type: "url", url: "https://media.zeptly-cdn.test/clip.mp4" }, filename: "clip.mp4", contentType: "video/mp4" });
    const img = await h.call(WS, "POST", "/v1/media", { source: { type: "url", url: "https://media.zeptly-cdn.test/pic.jpg" }, filename: "pic.jpg", contentType: "image/jpeg" });
    await h.drain();
    const mk = (body: unknown) => h.call(WS, "POST", "/v1/posts", body, { "idempotency-key": idem() });
    const both = await mk({ content: { mediaIds: [vid.json.id] }, targets: [{ connectionId: fb.id, options: { publishAsReel: true, publishAsStory: true } }] });
    expect(both.json.error.details.problems).toContain("facebook: publishAsReel and publishAsStory are mutually exclusive");
    const imageReel = await mk({ content: { mediaIds: [img.json.id] }, targets: [{ connectionId: fb.id, options: { publishAsReel: true } }] });
    expect(imageReel.json.error.details.problems).toContain("facebook: a Reel is exactly one video");
    const captionedStory = await mk({ content: { text: "hello", mediaIds: [img.json.id] }, targets: [{ connectionId: fb.id, options: { publishAsStory: true } }] });
    expect(captionedStory.json.error.details.problems.join()).toMatch(/Stories do not carry a caption/);
    const story = await mk({ content: { text: "base copy", mediaIds: [img.json.id] }, targets: [{ connectionId: fb.id, content: { text: "" }, options: { publishAsStory: true } }] });
    expect(story.status).toBe(201);
    await h.call(WS, "POST", `/v1/posts/${story.json.id}/publish`, undefined, { "idempotency-key": idem() });
    expect(h.fake.postRequests().at(-1)?.body).toMatchObject({ facebook: { publishAsStory: true } });
  });

  it("Instagram AI disclosure is passed through; unknown options stay rejected", async () => {
    h = await createHarness();
    const [ig] = await h.connect(WS, "instagram", [{ name: "IG" }]);
    const m = await h.call(WS, "POST", "/v1/media", { source: { type: "url", url: "https://media.zeptly-cdn.test/pic.jpg" }, filename: "pic.jpg", contentType: "image/jpeg" });
    await h.drain();
    const p = await h.call(WS, "POST", "/v1/posts", { content: { text: "made with AI", mediaIds: [m.json.id] }, targets: [{ connectionId: ig.id, options: { isAiGenerated: true } }] }, { "idempotency-key": idem() });
    await h.call(WS, "POST", `/v1/posts/${p.json.id}/publish`, undefined, { "idempotency-key": idem() });
    expect(h.fake.postRequests().at(-1)?.body).toMatchObject({ instagram: { isAiGenerated: true } });
    const trial = await h.call(WS, "POST", "/v1/posts", { content: { text: "x", mediaIds: [m.json.id] }, targets: [{ connectionId: ig.id, options: { trialParams: {} } }] }, { "idempotency-key": idem() });
    expect(trial.json.error.details.problems).toContain('instagram: option "trialParams" is not supported');
  });
});
