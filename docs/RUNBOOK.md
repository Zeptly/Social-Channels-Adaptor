# Runbook

## Signals

| Signal | Where | Healthy |
| --- | --- | --- |
| API liveness/readiness | `GET /health`, `GET /ready` | 200 / `ready` |
| Worker liveness | `worker_heartbeats.last_beat_at`; logs `job completed` | updated every few seconds |
| Dead letters | `GET /v1/admin/jobs?status=dead` | empty |
| Webhook failures | `GET /v1/admin/webhook-events?status=failed` | empty |
| Publications stuck | SQL below | none |

Every log line is JSON and carries `service`. Request logs carry `reqId`, `workspaceId` and `caller`. Provider calls log `provider`, `method`, `path`, `status`, `latencyMs`, `requestId` and `rateLimitRemaining`. Jobs log `jobType`, `jobId`, `attempt`, `outcome` and `latencyMs`.

## Common operations

Use the signed-request CLI: `ZS_BASE_URL=… ZEPTLY_SERVICE_SECRET=… pnpm zs <METHOD> <path> [json] [--idem] [--no-workspace]`.

- **Retry a dead job.** `pnpm zs POST /v1/admin/jobs/<id>/retry --no-workspace`
- **Reconcile after an incident or provider outage.** `pnpm zs POST /v1/admin/reconcile --no-workspace` enqueues publication and connection reconciliation for all workspaces.
- **Reconcile one post.** `ZS_WORKSPACE=<ws> pnpm zs POST /v1/social/publishing/posts/<id>/reconcile`
- **Reconcile one workspace's connections.** `ZS_WORKSPACE=<ws> pnpm zs POST /v1/connections/reconcile`

## Diagnosis queries

```sql
-- publications waiting for, or stuck in, hand-off
select id, workspace_id, status, publish_at, attempts, next_attempt_at, last_error_code, last_error
from social_publications where status in ('pending','retry_pending','dispatching') order by publish_at;

-- accepted by the provider but overdue (webhook missed; reconciliation should fix)
select id, provider_post_id, publish_at, last_reconciled_at from social_publications
where status = 'accepted' and publish_at < now() - interval '15 minutes';

-- ambiguous failures needing manual review (possible provider-side post)
select p.id, p.provider_post_id, p.idempotency_key, t.id as target_id, t.error_message
from social_publications p join social_post_targets t on t.publication_id = p.id
where t.error_code = 'PUBLICATION_STATE_UNKNOWN';

-- connections needing reauthorization
select workspace_id, network, status, status_reason from gateway_connections where status <> 'connected';
```

## Scheduled clean-ups

- **Next release after the gateway refactor:** remove the `social_connections` compatibility view (`DROP VIEW IF EXISTS social_connections;` as a new migration) once no previous-release process can be running. Also remove the deprecated HTTP aliases in the next major release ([API.md](API.md#breaking-changes-gateway-refactor)), after confirming from request logs that Zeptly no longer calls the legacy paths (`/v1/posts`, `/v1/media`, `/v1/networks`, `/v1/metrics`, `/v1/conversations`).

## Incident playbooks

- **`PUBLICATION_STATE_UNKNOWN`.** The provider may have accepted the post, but the service could not confirm within the 23 h idempotency window. Search the Outstand dashboard for posts on that account around `publish_at`. If the post exists, record the outcome. If it does not, Zeptly can create a new post; the old one is terminal.
- **Many `PROVIDER_UNAVAILABLE`/`RATE_LIMITED` errors.** Publications back off (1 m, 5 m, 15 m, 1 h, 3 h; at most 5 attempts). When Outstand recovers, run the global reconcile. Publications that exhausted their attempts are `failed` and need a new publish from Zeptly.
- **Webhook 401s.** The signing secret is out of sync. Re-copy it from Outstand into `OUTSTAND_WEBHOOK_SECRET` on both services. Outstand retries deliveries (up to 5), and periodic reconciliation covers anything missed.
- **Worker down.** Scheduled hand-offs and webhook processing pause, and nothing is lost: all state lives in PostgreSQL. Restart it. Stale claims are recovered after 10 minutes.
- **Secret leak.** Rotate using [SECURITY.md → Key rotation](SECURITY.md#key-rotation).

## First PAYG end-to-end validation

Prerequisites: API and worker deployed ([RAILWAY.md](RAILWAY.md)), the Outstand webhook registered, and a **dedicated test social account** you are willing to post from. The example uses LinkedIn or Bluesky.

```bash
export ZS_BASE_URL=https://<api-domain> ZEPTLY_SERVICE_SECRET=<secret> ZS_WORKSPACE=ws_payg_test
# ALLOWED_RETURN_URL_ORIGINS must include the origin used below.

# 0. Read-only provider checks (from a workstation with the key)
OUTSTAND_LIVE_TESTS=true OUTSTAND_LIVE_API_KEY=<key> pnpm test:live

# 1. Initiate a connection → open authorizationUrl in a browser, authorize the test account
pnpm zs POST /v1/connections '{"channel":"linkedin","returnUrl":"https://<allowed-origin>/social/return"}'
#    Browser returns to …?provisioningId=<pid>&status=completed|awaiting_selection
pnpm zs GET /v1/provisioning/<pid>                                   # if awaiting_selection: list options
pnpm zs POST /v1/provisioning/<pid>/finalize '{"optionIds":["<id>"]}'
#    (Bluesky alternative: '{"channel":"bluesky","credentials":{"handle":"…","appPassword":"…"}}')

# 2. Canonical SocialConnection
pnpm zs GET /v1/connections

# 3. Create + publish a SocialPost (idempotent)
pnpm zs POST /v1/social/publishing/posts '{"content":{"text":"Outstand Gateway PAYG validation"},"targets":[{"connectionId":"<cid>"}]}' --idem
pnpm zs POST /v1/social/publishing/posts/<post>/publish --idem

# 4–6. Webhook received → reconciled → canonical status published
pnpm zs GET /v1/admin/webhook-events --no-workspace                  # post.published processed
pnpm zs GET /v1/social/publishing/posts/<post>                                         # status published, platformPostUrl set

# 7. Metrics (may be empty until the network reports them)
pnpm zs POST /v1/social/analytics/posts/<post>/refresh

# 8. Scheduling: schedule 40 days ahead → stays local; confirm with publications = pending
pnpm zs POST /v1/social/publishing/posts '{"content":{"text":"Scheduled validation"},"targets":[{"connectionId":"<cid>"}]}' --idem
pnpm zs POST /v1/social/publishing/posts/<post2>/schedule '{"scheduledAt":"<now+40d ISO>","timezone":"Europe/London"}' --idem
pnpm zs GET /v1/social/publishing/posts/<post2>/publications                           # status pending (not handed off)
pnpm zs POST /v1/social/publishing/posts/<post2>/schedule '{"scheduledAt":"<now+2d ISO>"}' --idem
pnpm zs GET /v1/social/publishing/posts/<post2>/publications                           # new publication accepted (handed off)
pnpm zs POST /v1/social/publishing/posts/<post2>/cancel --idem                         # deletes the Outstand scheduled post

# 9. Conversations (Instagram professional account only): message the account from another IG user, then
pnpm zs GET "/v1/social/direct-messages/conversations?connectionId=<ig-cid>"
pnpm zs POST /v1/social/direct-messages/conversations/<conv>/messages '{"text":"Thanks for reaching out!"}' --idem
```

Then enable in-place editing: run the live suite with `OUTSTAND_LIVE_ALLOW_PUBLISH=true` and a dedicated test account. If the `PATCH /posts/{id}` test passes, set `OUTSTAND_POST_UPDATE_ENABLED=true` on both services. Otherwise leave it off; edits then use delete + recreate.

Record for each step: the HTTP status, the canonical status, and any `(to confirm live)` item from [OUTSTAND.md](OUTSTAND.md) that behaved differently from the documentation.
