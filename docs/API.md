# API

The machine-readable contract is [`openapi/openapi.json`](../openapi/openapi.json), OpenAPI 3.1, generated from the Zod route schemas. It is also served at `GET /openapi.json`, and CI fails if the committed file is stale (`pnpm openapi:check`). The API is a **Zeptly contract**, not a mirror of Outstand, and it returns canonical objects only.

It has two layers:

- **Gateway Contract v1**, which every Zeptly provider gateway implements: `/v1/gateway`, `/v1/capabilities`, `/v1/connections`, `/v1/provisioning`. See [GATEWAY-CONTRACT.md](GATEWAY-CONTRACT.md).
- The **capability contracts** this gateway implements on Outstand: `/v1/social/publishing`, `/v1/social/analytics` and `/v1/social/direct-messages`.

## Conventions

- Base path `/v1`. JSON only. Timestamps are ISO-8601. Execution instants are stored in UTC, and any offset is accepted on input.
- Every workspace route is authenticated with ZS1 signatures, and the workspace comes from `X-Zeptly-Workspace-Id`. See [SECURITY.md](SECURITY.md).
- Mutating commands require `Idempotency-Key`:
  - `POST …/posts`, `PATCH …/posts/{id}`, `/publish`, `/schedule` and `/cancel` under `/v1/social/publishing`;
  - `POST /v1/social/direct-messages/conversations/{id}/messages`.
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

`error.code` is typed as an open string in OpenAPI. Codes form an extensible registry: gateway codes plus codes registered by each capability contract. Handle an unknown code by its HTTP status.

## Endpoints

### Gateway (Gateway Contract v1)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/gateway` | service | Gateway descriptor: identity, `gatewayContractVersion`, capabilities (`id`, `version`, `enabled`), channels |
| GET | `/v1/gateway/health` | service | Local health checks (no provider traffic); 503 when unavailable |
| GET | `/v1/capabilities` | workspace | Per-capability availability for the workspace (`available`, `channels`, `connectionIds`, `reason`) |

### Connections and provisioning (Gateway Contract v1)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/connections/channels` | Channels this gateway can provision, with connection strategies and notes |
| GET | `/v1/connections?channel&status` | List connections (`network` accepted as a deprecated alias of `channel`) |
| POST | `/v1/connections` | Initiate provisioning `{channel, returnUrl?, credentials?}` → `{provisioning, connections}` (`network` accepted as a deprecated alias) |
| GET | `/v1/connections/{id}` | Get connection |
| POST | `/v1/connections/{id}/reconnect` | Start reauthorization `{returnUrl?, credentials?}` |
| DELETE | `/v1/connections/{id}` | Disconnect (also removed at the provider) |
| POST | `/v1/connections/reconcile` | Reconcile this workspace with the provider |
| GET | `/v1/provisioning/{id}` | Provisioning session (`options` when `awaiting_selection`) |
| POST | `/v1/provisioning/{id}/finalize` | `{optionIds}` → connections |
| GET | `/v1/connect/callback/{state}` | Browser return from the provider (public; not for Zeptly) |

On this gateway every channel is a social network. While Social Publishing is composed, connections are returned in their **social view** (`SocialConnection`): `channel` plus `network` (always equal) and the per-network feature flags `capabilities`.

### Social Publishing v1 and Social Scheduling v1 — `/v1/social/publishing`

| Method | Path | Description |
| --- | --- | --- |
| GET | `/networks` | Supported networks: features, constraints, verified option keys, connection strategies |
| POST | `/media` | `{source:{type:url|asset|upload,…}, filename, contentType, sizeBytes?}` |
| GET | `/media/{id}` | Status `pending_upload → processing → ready | failed` |
| POST | `/media/{id}/complete` | Confirm a direct upload |
| POST | `/posts` | Create draft `{content:{text,mediaIds}, targets:[{connectionId, content?, options?}], externalRef?}` |
| GET | `/posts?status&limit&cursor` | List |
| GET | `/posts/{id}` | Post with per-target status |
| PATCH | `/posts/{id}` | Edit a draft or scheduled post `{content?, targets?, externalRef?}` (same id; Idempotency-Key) |
| POST | `/posts/{id}/publish` | Publish now (202) |
| POST | `/posts/{id}/schedule` | `{scheduledAt, timezone?}` (any horizon; 202) — `social.scheduling` |
| POST | `/posts/{id}/cancel` | Cancel unpublished targets |
| GET | `/posts/{id}/publications` | Provider submissions (diagnostic, canonical ids only) |
| POST | `/posts/{id}/reconcile` | Reconcile now |

### Social Analytics v1 (`social.analytics.basic`) — `/v1/social/analytics`

| Method | Path | Description |
| --- | --- | --- |
| GET | `/metrics?postId|connectionId&history&limit` | Latest (or all) provider-reported metric snapshots |
| POST | `/posts/{id}/refresh` | Fetch fresh metrics for a published post |

### Social Direct Messages v1 — `/v1/social/direct-messages` (Instagram DMs only)

This is not a universal inbox: it covers one-to-one provider DMs on supported connections only.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/conversations?connectionId&limit&cursor` | List (network-gated) |
| GET | `/conversations/{id}` | Get |
| GET | `/conversations/{id}/messages?refresh` | Messages, newest first |
| POST | `/conversations/{id}/messages` | Reply `{text}` |

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


## Breaking changes (gateway refactor)

The repository was refactored from "zeptly-social, a universal social-provider router" into the **Outstand Gateway**. The wire behaviour of every pre-refactor operation is preserved. Every old path still works and returns the same bodies, and the full pre-refactor integration suite passes unchanged against the old paths. The changes Zeptly needs to know about are these.

### Paths moved (old paths are deprecated aliases for one release)

| Deprecated alias | Canonical path |
| --- | --- |
| `/v1/networks` | `/v1/social/publishing/networks` |
| `/v1/media…` | `/v1/social/publishing/media…` |
| `/v1/posts…` | `/v1/social/publishing/posts…` |
| `/v1/posts/{id}/metrics/refresh` | `/v1/social/analytics/posts/{id}/refresh` |
| `/v1/metrics` | `/v1/social/analytics/metrics` |
| `/v1/conversations…` | `/v1/social/direct-messages/conversations…` |

Aliases behave identically, carry `Deprecation: true` and `Link: <successor>; rel="successor-version"` response headers, and are marked `deprecated` in OpenAPI under the `legacy` tag. They will be **removed in the next major release**. `/v1/connections`, `/v1/provisioning`, `/v1/connect/callback` and `/v1/webhooks/outstand` did not move.

### Schema changes

| Change | Kind | Action for Zeptly |
| --- | --- | --- |
| `SocialConnection.channel` added (equals `network`) | additive | Prefer `channel` for gateway-level code; `network` remains |
| `ProvisioningSession.channel` added; `network` becomes a deprecated alias typed `string` | additive / loosened | Read `channel` |
| `CreateConnectionRequest.channel` added; `network` now optional (one of them required; they must match) | additive | Send `channel` |
| `GET /v1/connections?channel=` added (`network=` still accepted) | additive | — |
| `error.code` (responses and `target.error`, `publication.lastError`, `message.error`) typed as open `string` instead of a closed enum | loosened | Handle unknown codes by HTTP status (the set of emitted codes is unchanged) |
| `NetworkDescriptor` no longer carries `connectionStrategy`/`supportedStrategies`; `GET …/networks` items are `SocialNetworkInfo` (descriptor + both fields), so the response body is unchanged | schema refactor, wire-identical | — |
| OpenAPI title "Outstand Gateway API"; tags reorganised (`gateway`, `connections`, `social-publishing`, `social-analytics`, `social-direct-messages`, `legacy`) | documentation | Regenerate clients from `openapi/openapi.json` |

### New endpoints

- `GET /v1/gateway`
- `GET /v1/gateway/health`
- `GET /v1/capabilities`
- `GET /v1/connections/channels`

### Removed concepts

- The capability router ("capability + network + workspace → provider") and its per-workspace provider overrides. They were never reachable from the API. The gateway has one provider, and choosing between gateways is Zeptly's job.
