# Outstand Gateway

The **Outstand Gateway** is Zeptly's gateway to [Outstand](https://outstand.so). It is one provider gateway: it knows exactly one upstream provider and exposes what that provider can do through versioned, provider-neutral contracts:

- **Gateway Contract v1** (gateway identity, capability discovery, health, workspace-scoped connections and provisioning, canonical errors, webhook and audit envelopes). Every Zeptly provider gateway implements this contract. See [docs/GATEWAY-CONTRACT.md](docs/GATEWAY-CONTRACT.md).
- The **capability contracts** Outstand backs:
  - `social.publishing` v1 and `social.scheduling` v1: posts, media, targets, publications and long-range schedules;
  - `social.analytics.basic` v1: provider-reported post metrics;
  - `social.direct_messages` v1: Instagram DMs only, and deliberately not a universal inbox.

Only Outstand **Managed-Key** networks are served: LinkedIn, Instagram, Facebook, Threads, TikTok, Pinterest, YouTube and Bluesky. Outstand objects and identifiers never appear in the API.

> This repository lives in the `Zeptly/Social-Channels-Adaptor` GitHub repository. It was previously named `zeptly-social`. The upgrade notes are in [docs/API.md](docs/API.md#breaking-changes-gateway-refactor).

## What it is not

- It is **not** Zeptly's universal social-provider router. It does not pick between providers: every capability it reports is backed by Outstand. Another provider (for example Zernio) would be a **separate gateway** that implements the same Gateway Contract. Zeptly chooses between gateways.
- It has no UI of any kind: no Composer, Calendar or Inbox. It has no AI generation, Brand Engine, content recipes, campaign planning, approval policy, autonomous posting or end-user authentication. Zeptly owns all of those.
- It does not support X/Twitter, Reddit, Google Business Profile, Vimeo, BYOK, SMS or broadcasts.

## Architecture

```
Zeptly ──signed ZS1 requests──▶ Outstand Gateway API (/v1)
                                  │ Gateway Contract v1           /v1/gateway · /v1/capabilities · /v1/connections
                                  │ Social capability contracts   /v1/social/{publishing,analytics,direct-messages}
                                  ▼
                        gateway-core (tenancy, auth, provisioning, idempotency, jobs, webhooks, audit, discovery)
                                  ▼
                        capability services + typed Outstand capability adapters
                                  ▼
                        outstand-client (transport, auth, wire types, errors, rate limits) ──▶ Outstand ──▶ networks
PostgreSQL ◀── API + Worker (durable jobs, rolling schedule hand-off, reconciliation, webhooks)
```

| Path | Purpose |
| --- | --- |
| `apps/api` | Fastify HTTP API, route composition, OpenAPI generation |
| `apps/worker` | PostgreSQL-backed job runner, generic over the gateway's jobs, periodic work and ticks |
| `packages/gateway-contract` | **Gateway Contract v1**: identity, workspace, provider references, request context, capability descriptors, canonical errors, health, audit and webhook envelopes. Depends only on Zod |
| `packages/gateway-core` | Gateway infrastructure: service auth, tenant isolation, account ownership, provisioning, idempotency, jobs and retries, webhook ingestion, connection reconciliation, audit, capability registry and discovery. It knows no provider and no capability domain |
| `packages/outstand-client` | The only code that speaks Outstand HTTP: transport, auth, private wire schemas, typed results, errors, rate limits, webhook verification |
| `packages/adapters/social-publishing` | Social Publishing and Scheduling Contract v1 (`./contract`), the provider-neutral port, the canonical service, and the Outstand port implementation (`./outstand`) |
| `packages/adapters/social-analytics` | Social Analytics Contract v1, service and Outstand implementation |
| `packages/adapters/social-direct-messages` | Social Direct Messages Contract v1 (narrow), service and Outstand implementation |
| `packages/outstand-gateway` | Composition root: configuration, Outstand channel catalog, account port, webhook source, `createOutstandGateway()` |
| `packages/database` | Drizzle schema, client, migrator, seed |
| `packages/observability` | Structured logging and secret redaction |
| `packages/test-utils` | Stateful fake Outstand (tests and local dev), DB harness |
| `migrations/` | SQL migrations (drizzle-kit) |
| `openapi/openapi.json` | Committed OpenAPI 3.1 contract |
| `test/architecture.test.ts` | Static dependency and isolation rules |
| `docs/` | Gateway contract, architecture, API, Outstand, security, Railway, runbook, Zeptly integration, refactor report |

The design is detailed in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local development

Requirements: Node ≥ 22.12 (24 LTS recommended, see `.nvmrc`), pnpm 10, and Docker or a local PostgreSQL 16. No Outstand account is needed.

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
pnpm zs GET /v1/gateway --no-workspace
ZS_WORKSPACE=ws_local_test pnpm zs GET /v1/capabilities
pnpm zs POST /v1/connections '{"channel":"facebook","returnUrl":"http://localhost:3000/cb"}'
# open provisioning.authorizationUrl in a browser → mock consent → redirected back
```

## Tests

```bash
pnpm lint && pnpm typecheck
pnpm test:unit              # contracts, catalog, Outstand client fixtures, webhooks, transport, auth, redaction, architecture rules
pnpm test:integration       # needs PostgreSQL (TEST_DATABASE_URL, default …/zeptly_social_test)
pnpm test:live              # OPT-IN real Outstand suite (OUTSTAND_LIVE_TESTS=true + key); never in CI
pnpm db:check && pnpm db:drift   # migration consistency / schema drift
pnpm openapi:check          # committed OpenAPI is current
pnpm build
```

Integration tests drive the real Fastify app, the real Outstand client and a real PostgreSQL database. Only Outstand's HTTP API is faked, by a stateful, wire-accurate fake. Two architecture tests guard the refactor's goals:

- **A**: the gateway stays coherent with no capability modules. Discovery, provisioning, account-expiry webhooks and jobs keep working.
- **B**: the Social Publishing service runs unchanged against a non-Outstand, in-memory port.

## Railway deployment

There is one Docker image and three Railway services: **API**, **Worker** and **PostgreSQL**. `railway.toml` configures the API and `railway/worker.toml` configures the worker. See [docs/RAILWAY.md](docs/RAILWAY.md).

## Security boundary

- The Outstand API key and webhook secret exist only in this gateway's environment.
- Zeptly authenticates with signed service requests (ZS1-HMAC-SHA256, rotation supported).
- Ownership runs workspace → gateway connection → Outstand provider account. Every lookup is workspace-constrained, and a provider id never establishes access without a stored mapping.
- Webhooks are verified by HMAC over the raw bytes and deduplicated. Secrets are redacted from logs, stored payloads and errors.

See [docs/SECURITY.md](docs/SECURITY.md).
