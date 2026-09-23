# zeptly-social

**Zeptly Social** is the provider-neutral, headless social infrastructure gateway for Zeptly. It owns social **account provisioning** and **social execution**: publishing, long-range scheduling, media hand-off, signed webhooks, reconciliation, supported metrics and supported conversations. It exposes one stable, canonical API to the main Zeptly application.

V1 is implemented on **Outstand** (Managed-Key networks only). Outstand is an internal adapter. Its objects and identifiers never appear in the public API.

> This repository is `zeptly-social`. It lives in the `Zeptly/Social-Channels-Adaptor` GitHub repository.

## What it is not

There is no UI of any kind: no Composer, Calendar or Inbox. There is no AI generation, Brand Engine, content recipes, campaign planning, approval policy, autonomous posting or end-user authentication. Zeptly owns all of those. X/Twitter, Reddit, Google Business Profile, Vimeo, BYOK, Zernio and Unipile are also out of scope for V1 (see [docs/PROVIDERS.md](docs/PROVIDERS.md)).

## Architecture

```
Zeptly ──signed service calls──▶ Social API (Fastify, /v1)
                                   │  canonical domain (SocialConnection, SocialPost, …)
                                   ▼
                               capability router  (capability + network + workspace → provider)
                                   ▼
                               provider adapter (OutstandProvider)  ──▶ Outstand ──▶ networks
PostgreSQL ◀── API + Worker (durable jobs, rolling schedule hand-off, reconciliation, webhooks)
```

| Path | Purpose |
| --- | --- |
| `apps/api` | Fastify HTTP API, service auth, OpenAPI generation |
| `apps/worker` | PostgreSQL-backed job runner: hand-off, webhooks, reconciliation, metrics, conversations, housekeeping |
| `packages/domain` | Canonical models (Zod), error model, status aggregation |
| `packages/capability-registry` | Version-controlled network/capability registry and capability router |
| `packages/provider-contract` | `SocialProvider` interface, provider errors, registry |
| `packages/provider-outstand` | Outstand adapter: transport, wire mapping, webhooks, fixtures |
| `packages/core` | Application services shared by API and worker (tenancy, provisioning, posts, dispatch, …) |
| `packages/database` | Drizzle schema, client, migrator, seed |
| `packages/observability` | Structured logging and secret redaction |
| `packages/test-utils` | Stateful fake Outstand (tests and local dev), DB harness |
| `migrations/` | SQL migrations (drizzle-kit) |
| `openapi/openapi.json` | Committed OpenAPI 3.1 contract |
| `docs/` | Architecture, API, providers, Outstand, security, Railway, runbook, Zeptly integration |

The design is detailed in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), which includes Mermaid diagrams.

## Local development

Requirements: Node ≥ 22.12 (24 LTS recommended, see `.nvmrc`), pnpm 10, Docker (or a local PostgreSQL 16). No Outstand account is needed.

```bash
pnpm install
cp .env.example .env            # values are set up for the local mock Outstand
docker compose up -d            # PostgreSQL (+ zeptly_social_test database)
set -a; . ./.env; set +a
pnpm db:migrate
pnpm db:seed                    # optional: test workspace, connections, posts, history
pnpm dev:mock-outstand          # terminal 1: fake Outstand on :4010
pnpm dev                        # terminal 2: API on :8080 + worker
```

To call the API, use the signed-request CLI (see [docs/ZEPTLY-INTEGRATION.md](docs/ZEPTLY-INTEGRATION.md)):

```bash
ZS_WORKSPACE=ws_local_test pnpm zs GET /v1/networks
pnpm zs POST /v1/connections '{"network":"facebook","returnUrl":"http://localhost:3000/cb"}'
# open provisioning.authorizationUrl in a browser → mock consent → redirected back
```

## Tests

```bash
pnpm lint && pnpm typecheck
pnpm test:unit              # domain, routing, Outstand contract fixtures, webhooks, transport, auth, redaction
pnpm test:integration       # needs PostgreSQL (TEST_DATABASE_URL, default …/zeptly_social_test)
pnpm test:live              # OPT-IN real Outstand suite (OUTSTAND_LIVE_TESTS=true + key); never in CI
pnpm db:check && pnpm db:drift   # migration consistency / schema drift
pnpm openapi:check          # committed OpenAPI is current
pnpm build
```

Integration tests drive the real Fastify app, the real Outstand adapter and a real PostgreSQL database. Only Outstand's HTTP API is faked, by a stateful, wire-accurate fake. Coverage includes the connection lifecycle, multi-account and partial publishing, idempotency (timeouts after upstream acceptance, retries, duplicate requests and webhooks), rolling hand-off, token expiry, reconciliation, media, metrics, conversations and cross-tenant security.

## Railway deployment

There is one Docker image and three Railway services: **API**, **Worker** and **PostgreSQL**. `railway.toml` configures the API and `railway/worker.toml` configures the worker. Exact steps and variables are in [docs/RAILWAY.md](docs/RAILWAY.md).

## Provider model

Every capability is resolved through the capability router, keyed by capability, network and workspace. Provider identifiers live only in integration tables (`provider_accounts`, `social_publications.provider_post_id`, …). Adding Zernio or Unipile means adding an adapter and a capability table. The public API does not change. See [docs/PROVIDERS.md](docs/PROVIDERS.md) and [docs/OUTSTAND.md](docs/OUTSTAND.md).

## Security boundary

- The Outstand API key and webhook secret exist only in this service's environment.
- Zeptly authenticates with signed service requests (ZS1-HMAC-SHA256, rotation supported).
- Every tenant-owned row carries `workspace_id`. Every lookup is workspace-constrained, and provider ids are never trusted without a stored mapping.
- Webhooks are verified by HMAC over the raw bytes and deduplicated. Secrets are redacted from logs, stored payloads and errors.

See [docs/SECURITY.md](docs/SECURITY.md).
