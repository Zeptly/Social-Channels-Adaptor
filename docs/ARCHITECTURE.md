# Architecture

Zeptly Social is deliberately boring infrastructure. It has two Node.js processes, the **API** and the **Worker**. Both are built from one repository and one image, and they share one PostgreSQL database. PostgreSQL is the only coordination layer: there is no Redis and no message broker.

## Layers

| Layer | Package | Rule |
| --- | --- | --- |
| HTTP contract | `apps/api` | Zod-validated `/v1` routes; the only code that speaks HTTP to Zeptly |
| Canonical domain | `packages/domain` | `SocialConnection`, `SocialPost`, `SocialPostTarget`, `SocialPublication`, `SocialMedia`, `SocialConversation`, `SocialMessage`, `SocialMetric`, canonical errors |
| Application services | `packages/core` | Tenancy guards, provisioning, posts, dispatch queue, scheduling, webhooks, reconciliation, metrics, conversations, jobs, audit |
| Capability router | `packages/capability-registry` | (capability, network, workspace) → provider; versioned registry of verified capabilities/constraints |
| Provider contract | `packages/provider-contract` | `SocialProvider` interface + `ProviderError` |
| Provider adapter | `packages/provider-outstand` | Outstand transport, wire mapping, webhook verification |
| Persistence | `packages/database` | Drizzle schema + SQL migrations |

Provider identifiers stay in integration columns: `provider_accounts.external_id`, `social_publications.provider_post_id`, `social_media.provider_media_id` and `social_conversations.external_id`. They never leave through `packages/core/src/serializers.ts`, which is the only path from rows to public objects.

## 1. Overall system

```mermaid
flowchart LR
  subgraph Zeptly["Zeptly (UI, agents, planning, approvals)"]
    ZA[Zeptly backend]
  end
  subgraph ZS["Zeptly Social (this repo)"]
    API[API service<br/>Fastify /v1]
    W[Worker service<br/>job runner + hand-off]
    DB[(PostgreSQL<br/>state + job queue)]
    API <--> DB
    W <--> DB
  end
  O[Outstand API]
  N[(LinkedIn · Instagram · Facebook · Threads<br/>TikTok · Pinterest · YouTube · Bluesky)]
  ZA -- "signed ZS1 requests" --> API
  API -- "Bearer key (server-side)" --> O
  W -- "Bearer key (server-side)" --> O
  O -- "signed webhooks" --> API
  O --> N
  Browser[End-user browser] -- "authorizationUrl" --> O
  O -- "redirect ?session=" --> API
  API -- "303 → Zeptly returnUrl" --> Browser
```

## 2. Account provisioning

Outstand owns the OAuth callback for Managed-Key networks, so Zeptly never receives platform credentials. Ownership is proven by an unguessable **state token** embedded in the redirect URI. That token binds the browser return to exactly one provisioning session and so to one workspace. Outstand also receives an opaque per-workspace `tenant_id` (`zs_<random>`), never the Zeptly workspace id.

```mermaid
sequenceDiagram
  autonumber
  participant Z as Zeptly
  participant S as Zeptly Social
  participant O as Outstand
  participant B as Browser
  Z->>S: POST /v1/connections {network, returnUrl}
  S->>O: POST /social-networks/{network}/auth-url {redirect_uri=/v1/connect/callback/<state>, tenant_id}
  O-->>S: auth_url
  S-->>Z: provisioning {id, status: initiated, authorizationUrl}
  Z->>B: redirect to authorizationUrl
  B->>O: consent (platform OAuth / Bluesky app password)
  O->>B: 302 → /v1/connect/callback/<state>?session=…
  B->>S: GET callback (state → exactly one session)
  S->>O: GET /social-accounts/pending/{session}
  alt one selectable account
    S->>O: POST …/finalize
    S->>S: map accounts → workspace (provider_accounts UNIQUE)
  else several pages
    S->>S: status awaiting_selection (options stored)
  end
  S->>B: 303 → returnUrl?provisioningId=…&status=…
  Z->>S: GET /v1/provisioning/{id} → options
  Z->>S: POST /v1/provisioning/{id}/finalize {optionIds}
  S->>O: POST /social-accounts/pending/{session}/finalize
  S-->>Z: canonical SocialConnection(s)
```

Bluesky offers two strategies. `provider_managed` uses the same hosted flow, where Outstand collects the app password. With `credentials`, Zeptly sends `{handle, appPassword}` once. The service forwards them to `POST /social-accounts/bluesky` and never stores or logs them.

## 3. Immediate publication

```mermaid
sequenceDiagram
  autonumber
  participant Z as Zeptly
  participant S as API
  participant DB as PostgreSQL
  participant O as Outstand
  Z->>S: POST /v1/posts (Idempotency-Key) {content, targets}
  S->>DB: validate targets ↔ workspace connections, constraints; insert draft
  Z->>S: POST /v1/posts/{id}/publish (Idempotency-Key)
  S->>DB: group targets → publications (queue entries), status queued
  S->>DB: claim (FOR UPDATE SKIP LOCKED) + persist provider Idempotency-Key (UUIDv4)
  S->>O: POST /posts/ {accounts:[provider ids], containers} + Idempotency-Key
  O-->>S: post {socialAccounts[]}
  S->>DB: compare requested vs returned accounts → missing = TARGET_DROPPED_BY_PROVIDER
  S-->>Z: 202 SocialPost (targets: publishing | failed)
  O-->>S: webhook post.published / post.error (later)
```

On a timeout or 5xx the publication moves to `retry_pending`. The worker retries it with the **same** key, so Outstand replays the original post and no duplicate is created.

## 4. Long-range scheduling (rolling hand-off)

Zeptly's schedule is canonical and is stored in `social_schedules`, with publications carrying `publish_at` in UTC. Outstand accepts `scheduledAt` at most `OUTSTAND_SCHEDULING_HORIZON_DAYS` (30) ahead. The worker hands a publication off once `publish_at ≤ now + horizon − OUTSTAND_HANDOFF_MARGIN_MINUTES`.

```mermaid
flowchart TD
  A[POST /v1/posts/:id/schedule<br/>scheduledAt any horizon] --> B[(social_schedules<br/>social_publications status=pending)]
  B --> C{worker tick every 60s:<br/>publish_at ≤ now + 30d − margin?}
  C -- no --> B
  C -- yes --> D[claim + persist Idempotency-Key]
  D --> E[OutstandProvider.schedule scheduledAt=publish_at]
  E --> F[publication accepted<br/>targets scheduled]
  F --> G[Outstand publishes at publish_at]
  G --> H[webhook + reconciliation → published / partially_published / failed]
  A2[reschedule / cancel] --> I{handed off?}
  I -- yes --> J[DELETE provider post] --> K[cancel publication, create new]
  I -- no --> K
```

## 5. Webhook processing and reconciliation

```mermaid
sequenceDiagram
  autonumber
  participant O as Outstand
  participant S as API
  participant DB as PostgreSQL
  participant W as Worker
  O->>S: POST /v1/webhooks/outstand (X-Outstand-Signature)
  S->>S: HMAC-SHA256 over raw bytes (constant-time) — invalid → 401, nothing stored
  S->>DB: insert webhook_events UNIQUE(provider, event id) + enqueue process_webhook (1 tx)
  S-->>O: 200 {accepted, duplicate}
  W->>DB: claim job
  alt post.published / post.error
    W->>DB: find publication by stored provider_post_id (unknown → ignored, no provider call)
    W->>DB: apply facts to listed accounts only (via stored mappings)
    W->>O: GET /posts/{id} (authoritative, every target)
    W->>DB: settle targets, aggregate publication + post status
  else account.token_expired
    W->>DB: mapping → connection status reauthorization_required
  else message.*
    W->>DB: mapping → upsert conversation/message (Instagram only)
  end
  Note over W,O: Periodic: reconcile_publications (accepted & overdue), reconcile_connections (health, lost finalizations)
```

## 6. Future multi-provider capability routing

```mermaid
flowchart LR
  Z[Zeptly public API call<br/>canonical objects only] --> R{Capability router<br/>capability + network + workspace}
  R -- "publish/schedule/media: 8 Managed-Key networks" --> OA[OutstandProvider V1]
  R -. "future: extra networks, richer analytics, ads, inbox" .-> ZE[ZernioProvider — not implemented]
  R -. "future: batch/workflow operations" .-> UP[UnipileProvider — not implemented]
  OA --> O[Outstand]
  ZE -.-> Z2[Zernio]
  UP -.-> U2[Unipile]
```

Routing uses one `ProviderCapabilityTable` per provider, and resolution is first-match in table order. A workspace override can change that order, for example for a pilot. Operations on an existing resource use the provider that owns it (`social_connections.provider`), which keeps each connection's provider mapping stable. The router tests include a hypothetical second provider to show that routing changes need no API change.

## Data model (PostgreSQL)

| Table | Role |
| --- | --- |
| `workspaces` | External Zeptly workspace id + opaque provider tenant ref (nothing else) |
| `provisioning_sessions` | State-token-bound connection flows (hash of state, short-lived provider session handle) |
| `social_connections` | Canonical connection + status |
| `provider_accounts` | workspace → connection → provider account mapping; `UNIQUE(provider, external_id)` |
| `social_media` | Media references + provider media ids (no blobs) |
| `social_posts` / `social_post_targets` | Canonical post + per-connection target state; `UNIQUE(workspace_id, idempotency_key)` |
| `social_publications` | Provider submission per (network, content, options) group; doubles as dispatch queue |
| `social_schedules` | Canonical schedule (UTC + original timezone, revision) |
| `social_conversations` / `social_messages` | Provider-neutral DMs |
| `social_metrics` | Metric snapshots per target, network-scoped semantics |
| `provider_events` | Normalized provider-side state changes |
| `webhook_events` | Deduplicated receipts (redacted payload, hash, status, attempts, error) |
| `jobs` | Durable job queue (dedupe, bounded retries, dead letters) |
| `audit_events` | Audit trail (service + agent + request id) |
| `idempotency_keys` | API-level command idempotency |
| `worker_heartbeats` | Worker liveness |

Every tenant-owned table has a `workspace_id` foreign key. Status values are canonical strings validated by the domain schemas.
