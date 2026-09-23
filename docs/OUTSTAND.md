# Outstand adapter (V1)

Code lives in `packages/provider-outstand` (`http.ts` transport, `wire.ts` mapping, `webhooks.ts`, `provider.ts`). Wire fixtures are in `packages/provider-outstand/test/fixtures/2026-09/`.

## Evidence and verification status

The build environment's egress policy **blocked** `outstand.so`, `docs.outstand.so` and `api.outstand.so`, so the documentation could not be fetched live. Every contract below therefore comes from these sources, listed in priority order:

1. **Outstand's official npm package `@outstand-so/ui` v0.1.13** (published by Outstand). Its TypeScript declarations and compiled hooks define the REST calls, envelopes and types.
2. **The Outstand-UI reference implementation** (the zip the user supplied). It records the webhook contract, which the reference's ADR-0012 verified against Outstand's live documentation on 2026-09-23, and the per-network channel specifications.
3. **`github.com/pigfox/outstand-go` v0.1.0**, a production client. It records a live probe showing the create-post key must be `accounts` (`socialAccountIds` returns 400), that `network_data` OAuth tokens are embedded in post responses, and the `X-Outstand-Signature` format.
4. **Search-indexed Outstand documentation excerpts.** These cover the `Idempotency-Key` rules (UUID v4, 24 h, POST/PUT/PATCH, `Idempotency-Replay: true`), rate limits, the Bluesky app-password endpoint and the Instagram DM conversation events.

Items marked **(to confirm live)** below have not been exercised against the real API. `pnpm test:live` and [RUNBOOK.md → First PAYG validation](RUNBOOK.md#first-payg-end-to-end-validation) confirm them.

## Authentication

`Authorization: Bearer <OUTSTAND_API_KEY>`, base URL `OUTSTAND_API_BASE_URL` (default `https://api.outstand.so/v1`). The key exists only in this service's environment. It is registered for value-level redaction and never appears in logs, errors, database rows or API responses (covered by tests).

## Implemented endpoints

| Operation | Outstand call | Notes |
| --- | --- | --- |
| Credential probe | `GET /social-accounts?limit=1` | Not used by `/ready` (no provider traffic from health checks) |
| Start OAuth provisioning | `POST /social-networks/{network}/auth-url` `{redirect_uri, tenant_id}` → `data.auth_url` | `tenant_id` = opaque `zs_<random>` per workspace |
| Pending session | `GET /social-accounts/pending/{session}` → `{network, expiresAt, availablePages[]}` | `expiresAt` epoch seconds or ISO |
| Finalize | `POST /social-accounts/pending/{session}/finalize` `{selectedPageIds}` → `data.connectedAccounts[]` | |
| Bluesky credentials | `POST /social-accounts/bluesky` `{handle, app_password, tenant_id}` | **(to confirm live)**: the password field name follows Outstand's snake_case convention |
| List accounts | `GET /social-accounts?limit&offset[&tenantId]` | Paginated (50) |
| Disconnect | `DELETE /social-accounts/{id}` | 404 treated as done |
| Media upload | `POST /media/upload` `{filename, content_type}` → `{id, upload_url, expires_in}`; `PUT upload_url`; `POST /media/{id}/confirm` `{size}` | Bytes never stored in PostgreSQL |
| Create post | `POST /posts/` `{accounts[], containers[{content, media[]}], scheduledAt?, <network options>}` + `Idempotency-Key` | Returns `{success, post}` |
| Get post | `GET /posts/{id}` | Accepts `data`, `data.post`, `post` envelopes **(to confirm live)** |
| Delete/cancel post | `DELETE /posts/{id}` | Used for cancel/reschedule of handed-off posts |
| Analytics | `GET /posts/{id}/analytics` → `metrics_by_account[]` | |
| Conversations | `GET /conversations?social_account_id=`, `GET /conversations/{id}/messages`, `POST /conversations/{id}/messages {text}` | **(to confirm live)**: paths and payloads follow Outstand's Conversations API description; parsing is tolerant |

## Mappings

| Canonical | Outstand |
| --- | --- |
| `SocialConnection` (+ `provider_accounts.external_id`) | social account `id` |
| `SocialConnection.status` | `isActive=0` or `account.token_expired` → `reauthorization_required`; missing at provider → `degraded` |
| `SocialPostTarget` | `post.socialAccounts[]` entry (matched by account id, never username) |
| target `pending/scheduled/publishing` | account status `pending` (future `publish_at` → `scheduled`) |
| target `published` | account status `published` (+ `platformPostId`, `platformPostUrl`) |
| target `failed` | account status `failed`, or requested account **missing** → `TARGET_DROPPED_BY_PROVIDER` |
| target `cancelled` | account status `deleted` |
| `SocialPublication` | one Outstand post per (network, text, media, options) group |
| `SocialMetric` | `metrics_by_account[].metrics.{likes,comments,shares,reach,saves,views,impressions}` when present; `platform_specific` numeric keys as `platform.<key>` |
| `SocialConversation` / `SocialMessage` | Instagram DM conversation/message |
| network options | `threads.replyControl`; `instagram.mediaType/shareToFeed`; `youtube.title/privacyStatus/categoryId/tags`; `tiktok.privacyLevel/disableDuet/disableStitch/disableComment`; `pinterest.board_id` (canonical `boardId`) |

`network_data` (per-network OAuth tokens embedded in post responses) is never lifted out. Mapping is allowlist-only, and tests assert that tokens never reach canonical objects or the database.

## Managed-Key networks (V1)

LinkedIn, Instagram, Facebook, Threads, TikTok, Pinterest, YouTube and Bluesky. X/Twitter, Reddit, Google Business Profile and Vimeo need BYOK. They are not representable in the public contract: the Zod enum rejects them.

The capability registry (`packages/capability-registry/src/outstand-v1.ts`, version `2026.09.23-1`) records per network the connection strategy, capabilities and constraints: text limit, required media, allowed mime types and sizes, item counts, and verified option keys.

## Provider limitations

- **Scheduling horizon.** Outstand rejects `scheduledAt` more than 30 days ahead with a 400, and no post is created. This service keeps the canonical schedule and hands off only inside `OUTSTAND_SCHEDULING_HORIZON_DAYS − OUTSTAND_HANDOFF_MARGIN_MINUTES`. The adapter also refuses out-of-horizon schedules before any request is sent.
- **No verified update/reschedule API.** Rescheduling or cancelling a handed-off post deletes it at Outstand and creates a new publication with a new key. This is refused once any target has published.
- **Silent target omission.** Outstand can silently ignore unresolved account identifiers when at least one resolves. The service always targets by account id and compares requested with returned accounts. Any missing target becomes an explicit `TARGET_DROPPED_BY_PROVIDER` failure, and the post becomes `partially_published` or `failed`, never `published`.
- **Media expiry.** Outstand media has an `expires_at`. At hand-off, media expiring before the publish time is re-uploaded from its durable source URL. Direct uploads cannot be refreshed, so for long-range schedules register media by URL.
- **Pinterest.** Every Pin needs one image or video and a `boardId`. Pin title and link are not mapped because no Outstand field is evidenced for them.
- **TikTok.** Video only. Unaudited apps may be limited to `SELF_ONLY`.
- **Comments / first comment.** Outstand has comment endpoints, but V1 does not expose them (`comments=false`, `firstComment=false`).
- **Rate limits.** Outstand documents 20–500 requests/minute/account (dynamic) and 50,000/day. The transport honours `Retry-After` (up to 10 s inline; longer waits go back to job-level backoff) and exposes `PROVIDER_RATE_LIMITED`.

## Conversation limitations

Outstand does **not** provide a universal inbox. It documents **Instagram Direct Messages** only, so only Instagram advertises `conversations=true` and `directMessages=true`. Instagram's own rules apply:

- A business cannot start a conversation. The contact must message first.
- Replies must be sent within Meta's 24-hour window, unless Human Agent is approved.
- Only messages after connection (with the messaging permission) exist. No history is imported.

Every other network returns `422 CAPABILITY_NOT_SUPPORTED` from the conversation endpoints. The canonical `SocialConversation` model has no Instagram-specific fields, so other providers can be aggregated later.

## Webhook behaviour

- Endpoint: `POST <PUBLIC_BASE_URL>/v1/webhooks/outstand`. Register it in the Outstand dashboard with a signing secret, and store that secret as `OUTSTAND_WEBHOOK_SECRET`.
- Signature: `X-Outstand-Signature: sha256=<hex HMAC-SHA256(raw body, secret)>`, compared in constant time over the exact received bytes. A missing, malformed or invalid signature gets **401**, and nothing is stored.
- Envelope `{event, timestamp, data}`. Handled events:
  - `post.published`: at least one account published.
  - `post.error`: all accounts failed.
  - `account.token_expired`: `accountId` may be a number.
  - `conversation.started`, `message.received`, `message.sent`, `message.failed`.
  - `test`.
  - `import.*` and unknown events are recorded as `ignored`.
- Dedupe identity is `evt:<event>:<postId|accountId|…>:<timestamp>` (Outstand's recommendation), falling back to the body hash, under a UNIQUE constraint. Duplicates get `200 {duplicate:true}`.
- Processing is asynchronous: receipt and job are written in one transaction, then the response is 200. The worker then:
  1. applies facts for the listed accounts only, through stored mappings;
  2. **always** re-reads `GET /posts/{id}` as the authoritative view of every target.
- A webhook naming a post this service did not create is ignored and triggers **no** provider call.
- Outstand retries deliveries up to 5 times with exponential backoff, and processing is idempotent.

## Idempotency behaviour

- The provider `Idempotency-Key` is a UUID v4, generated and **persisted by the publication claim before any request**, and reused on every retry of that publication.
- Outstand remembers keys for 24 h, and replays return the original post (`Idempotency-Replay: true`).
- Ambiguous failures (timeout, network drop, 5xx or 409 after send) are retried only while the key is younger than 23 h. After that the targets fail with `PUBLICATION_STATE_UNKNOWN` for manual review, which prevents a silent duplicate.
- The transport retries only when it is safe: GET/DELETE, or POST carrying an Idempotency-Key. Unkeyed mutating calls such as finalize or media upload are never retried automatically.
- Direct-message sends carry `Idempotency-Key = <our message id>` **(to confirm live)**.

## Discrepancies with the Master Specification

| Spec assumption | Verified behaviour | Handling |
| --- | --- | --- |
| Bluesky uses app password rather than OAuth | Both exist: Outstand's hosted flow collects the app password, and a direct `POST /social-accounts/bluesky` is documented | Both strategies modelled (`provider_managed` default, `credentials`) |
| Create-post targets documented as `socialAccountIds` in places | The live API requires `accounts` | Adapter sends `accounts` only |
| `GET /posts/{id}` response shape | Not in the official UI package; envelopes vary | Tolerant decoding; to confirm live |
| Webhook payload keys | `accountId` (not `id`); numeric ids for token expiry | Implemented per verified contract |
| Webhook `post.published` as success | Means *at least one* account succeeded | Never treated as full success; authoritative GET always follows |
