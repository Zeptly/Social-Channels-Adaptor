# API

The machine-readable contract is [`openapi/openapi.json`](../openapi/openapi.json), OpenAPI 3.1, generated from the Zod route schemas. It is also served at `GET /openapi.json`, and CI fails if the committed file is stale (`pnpm openapi:check`). The API is a **Zeptly contract**, not a mirror of Outstand, and it returns canonical objects only.

## Conventions

- Base path `/v1`. JSON only. Timestamps are ISO-8601. Execution instants are stored in UTC, and any offset is accepted on input.
- Every workspace route is authenticated with ZS1 signatures, and the workspace comes from `X-Zeptly-Workspace-Id`. See [SECURITY.md](SECURITY.md).
- Mutating commands require `Idempotency-Key`: `POST /v1/posts`, `/publish`, `/schedule`, `/cancel` and `POST /v1/conversations/{id}/messages`.
  - The same key with the same request returns the original response, with header `Idempotency-Replay: true`.
  - The same key with a different request returns `409 IDEMPOTENCY_CONFLICT`.
- Every response carries `X-Request-Id`, echoed from the request or generated.
- Pagination uses `limit` (≤ 100) and an opaque `cursor`. Responses are `{ data: [...], nextCursor? }`.

## Error model

```json
{ "error": { "code": "CAPABILITY_NOT_SUPPORTED", "message": "…", "retryable": false,
             "details": { "network": "facebook", "capability": "conversations" }, "requestId": "…" } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `AUTHENTICATION_FAILED` | 401 | Missing/invalid service signature |
| `WORKSPACE_FORBIDDEN` | 403 | Missing/invalid workspace header |
| `NOT_FOUND`, `CONNECTION_NOT_FOUND`, `POST_NOT_FOUND`, `MEDIA_NOT_FOUND`, `CONVERSATION_NOT_FOUND`, `PROVISIONING_NOT_FOUND` | 404 | Not found **in this workspace** |
| `PROVISIONING_EXPIRED` | 410 | Start a new connection |
| `CONNECTION_OWNERSHIP_CONFLICT` | 409 | Provider account already belongs to another workspace |
| `CAPABILITY_NOT_SUPPORTED`, `NETWORK_NOT_SUPPORTED` | 422 | Capability/network not offered |
| `VALIDATION_ERROR` | 400 | Request/constraint validation (`details.problems` / `details.issues`) |
| `MEDIA_INVALID`, `TARGET_INVALID`, `PROVIDER_REJECTED` | 422 | Media/target invalid, or provider refused |
| `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_CONFLICT` | 400 / 409 | See conventions |
| `INVALID_STATE` | 409 | Operation not allowed in current status |
| `REAUTHORIZATION_REQUIRED`, `CONNECTION_NOT_ACTIVE` | 409 | Reconnect first |
| `PROVIDER_RATE_LIMITED` | 429 | Retry later (`Retry-After`) |
| `PROVIDER_UNAVAILABLE` | 503 | Provider outage/credentials (retryable when flagged) |
| `PUBLICATION_FAILED`, `TARGET_DROPPED_BY_PROVIDER`, `PUBLICATION_STATE_UNKNOWN` | (target-level) | Appear on `SocialPostTarget.error` |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | Webhook rejected |
| `INTERNAL_ERROR` | 500 | Unexpected |

Provider diagnostics, when present, sit under `details.provider` (`name`, `kind`, `status`, and a sanitized `message`). Zeptly should branch on `code` and never on the message.

## Endpoints

### Networks and connections

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/networks` | Supported networks: strategy, capabilities, constraints, verified option keys |
| GET | `/v1/connections?network&status` | List connections |
| POST | `/v1/connections` | Initiate provisioning `{network, returnUrl?, credentials?}` → `{provisioning, connections}` |
| GET | `/v1/connections/{id}` | Get connection |
| POST | `/v1/connections/{id}/reconnect` | Start reauthorization `{returnUrl?, credentials?}` |
| DELETE | `/v1/connections/{id}` | Disconnect (also removed at provider) |
| POST | `/v1/connections/reconcile` | Reconcile this workspace with the provider |
| GET | `/v1/provisioning/{id}` | Provisioning session (`options` when `awaiting_selection`) |
| POST | `/v1/provisioning/{id}/finalize` | `{optionIds}` → connections |
| GET | `/v1/connect/callback/{state}` | Browser return from provider (public; not for Zeptly) |

### Media

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/media` | `{source:{type:url|asset|upload,…}, filename, contentType, sizeBytes?}` |
| GET | `/v1/media/{id}` | Status `pending_upload → processing → ready | failed` |
| POST | `/v1/media/{id}/complete` | Confirm a direct upload |

### Posts

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/posts` | Create draft `{content:{text,mediaIds}, targets:[{connectionId, content?, options?}], externalRef?}` |
| GET | `/v1/posts?status&limit&cursor` | List |
| GET | `/v1/posts/{id}` | Post with per-target status |
| POST | `/v1/posts/{id}/publish` | Publish now (202) |
| POST | `/v1/posts/{id}/schedule` | `{scheduledAt, timezone?}` (any horizon; 202) |
| POST | `/v1/posts/{id}/cancel` | Cancel unpublished targets |
| GET | `/v1/posts/{id}/publications` | Provider submissions (diagnostic, canonical ids only) |
| POST | `/v1/posts/{id}/reconcile` | Reconcile now |
| POST | `/v1/posts/{id}/metrics/refresh` | Fetch fresh metrics |

### Metrics

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/metrics?postId|connectionId&history&limit` | Latest (or all) metric snapshots |

### Conversations (Instagram DMs in V1)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/conversations?connectionId&limit&cursor` | List (capability-gated) |
| GET | `/v1/conversations/{id}` | Get |
| GET | `/v1/conversations/{id}/messages?refresh` | Messages, newest first |
| POST | `/v1/conversations/{id}/messages` | Reply `{text}` |

### Webhooks, admin, health

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/webhooks/outstand` | Outstand webhook receiver (HMAC) |
| GET | `/v1/admin/jobs?status` | Job queue / dead letters (service auth, no workspace) |
| POST | `/v1/admin/jobs/{id}/retry` | Requeue a dead job |
| GET | `/v1/admin/webhook-events?status` | Webhook receipts |
| POST | `/v1/admin/reconcile` | Enqueue global reconciliation |
| GET | `/health` | Liveness |
| GET | `/ready` | Database + migrations + configuration (no provider traffic) |

## Status models

- **Connection:** `pending | connected | degraded | reauthorization_required | disconnected`.
- **Post:** `draft → queued → publishing → published | partially_published | failed`. The alternative paths are `draft → scheduled → publishing → …` and `cancelled`.
- **Target:** `pending | scheduled | publishing | published | failed | cancelled`. A failed target carries `error.code`.
- **Publication:** `pending | dispatching | retry_pending | accepted | published | partially_published | failed | cancelled`.

A post is `published` only when **every** target published. Any mix of outcomes is `partially_published`.
