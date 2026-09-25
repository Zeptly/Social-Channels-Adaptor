# Outstand Gateway refactor — implementation report

This report covers the controlled refactor of `zeptly-social` (a "provider-neutral social gateway" with an internal capability router) into the **Outstand Gateway**: one provider gateway implementing Gateway Contract v1 and the Outstand-backed capability contracts. It is a refactor, not a rebuild. Behaviour, security, database semantics, the API/worker topology and the Outstand functionality are preserved.

**Nothing was deployed.** No Railway or live-Outstand validation was performed in this work; see §9.

## 1. Baseline (before any change, commit `3922f74`)

| Check | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | 13 files passed, 1 skipped; **140 tests passed**, 6 skipped (the opt-in live Outstand suite) |
| `pnpm build` | pass (API + worker bundles) |
| `pnpm openapi:check` | up to date |
| `pnpm db:check` / drift | consistent / no schema changes |

## 2. Architecture: before and after

**Before**

```
Zeptly → Fastify API (/v1/posts, /v1/media, …)
          → packages/core (all services: tenancy, provisioning, posts, dispatch, webhooks, metrics, conversations)
          → CapabilityRouter (capability + network + workspace → provider)
          → ProviderRegistry → SocialProvider (OutstandProvider) → Outstand
packages/domain held every canonical model (connections, posts, metrics, conversations) and all error codes.
```

**After**

```
Zeptly → Outstand Gateway API
           Gateway Contract v1:    /v1/gateway · /v1/capabilities · /v1/connections · /v1/provisioning
           capability contracts:   /v1/social/publishing · /v1/social/analytics · /v1/social/direct-messages
        → gateway-core            tenancy, auth, ownership, provisioning, idempotency, jobs, webhooks, audit, discovery
        → capability services     over provider-neutral ports
        → typed capability adapters (adapters/*/src/outstand)
        → outstand-client         transport, auth, wire types, errors, rate limits
        → Outstand
```

The router, the provider registry and per-workspace provider overrides are gone. The gateway has exactly one provider, and discovery reports what that provider offers a workspace. See [ARCHITECTURE.md](ARCHITECTURE.md).

## 3. Packages and contracts

| Package | Role | Came from |
| --- | --- | --- |
| `packages/gateway-contract` | **Gateway Contract v1** (Zod only): identity and descriptor, workspace, `ProviderReference`, request context, branded idempotency and correlation ids, capability descriptors and availability, health, `GatewayConnection`, provisioning, extensible canonical error registry (`GatewayError`, `defineErrorCodes`), `UpstreamError`, audit and webhook envelopes, `Gateway` interface | `domain/errors.ts` + new |
| `packages/gateway-core` | Gateway infrastructure: service auth (moved from `apps/api`), tenancy, `ProviderAccountPort` + `ChannelCatalog`, provisioning and connection lifecycle, idempotency, jobs and runner, `WebhookSource` + event-kind dispatch, connection reconciliation, audit, `CapabilityModule`/`CapabilityRegistry`, error translation | `packages/core` (infrastructure parts) |
| `packages/outstand-client` | `OutstandClient`: the only Outstand HTTP code. Private `wire.ts`, typed sanitized results (`types.ts`), `OutstandError extends UpstreamError`, webhook verification and parsing | `packages/provider-outstand` |
| `packages/adapters/social-publishing` | **Social Publishing v1 + Social Scheduling v1** contract (`./contract`), `SocialPublishingPort`, `NetworkCatalog`, services (posts, media, dispatch, reconcile, validation, URL safety), publication-outcome webhook handler, capability modules; `./outstand`: `OutstandSocialPublishingAdapter` + verified network catalog | `core` social services, `domain` models, `capability-registry` table |
| `packages/adapters/social-analytics` | **Social Analytics v1** (`social.analytics.basic`): `SocialMetric`, `SocialAnalyticsPort`, service, module; `./outstand` adapter | `core/metrics.ts` |
| `packages/adapters/social-direct-messages` | **Social Direct Messages v1** (narrow, Instagram only): conversation and message schemas, `CONVERSATION_NOT_FOUND`, port, service, webhook handler, module; `./outstand` adapter | `core/conversations.ts` |
| `packages/outstand-gateway` | Composition root: config, channel catalog (connection strategies), `OutstandAccountPort`, Outstand `WebhookSource`, `createOutstandGateway()` implementing `Gateway` | `core/config.ts`, `core/factory.ts` |
| `packages/database`, `observability`, `test-utils` | Unchanged roles (schema rename, see §5) | — |

Removed: `packages/core`, `packages/domain`, `packages/capability-registry`, `packages/provider-contract` and `packages/provider-outstand`. Their code was moved with `git mv`, so history is preserved. The npm scope changed from `@zeptly-social/*` to `@zeptly-gateway/*`.

**Contract rules.** Gateway Contract v1 defines no social post, conversation, SMS, broadcast, analytics metric or provider-account object. Capability contracts depend only on Zod and the Gateway Contract; direct messages and analytics also reuse the publishing contract's `SocialNetwork`. Error codes are registered by the contract that owns them. See [GATEWAY-CONTRACT.md](GATEWAY-CONTRACT.md).

## 4. API changes

- **New:**
  - `GET /v1/gateway` (service auth): descriptor with `gatewayContractVersion: "1"`, capabilities `social.publishing@1`, `social.scheduling@1`, `social.analytics.basic@1` and `social.direct_messages@1`, and the channels.
  - `GET /v1/gateway/health`: local checks only, no provider traffic.
  - `GET /v1/capabilities` (workspace): availability derived from active connections.
  - `GET /v1/connections/channels`.
- **Canonical capability surfaces:**
  - `/v1/social/publishing/{networks,media,posts…}`
  - `/v1/social/analytics/{metrics,posts/{id}/refresh}`
  - `/v1/social/direct-messages/conversations…`
- **Preserved:** `/v1/connections`, `/v1/provisioning`, `/v1/connect/callback` and `/v1/webhooks/outstand`. Connections gained `channel`; `network` is kept.
- **Deprecated aliases (one release):** `/v1/posts…`, `/v1/media…`, `/v1/networks`, `/v1/metrics`, `/v1/posts/{id}/metrics/refresh` and `/v1/conversations…`. They run the same handlers, send `Deprecation`/`Link` headers, and are marked `deprecated` in OpenAPI.
- **OpenAPI regenerated:** 34 canonical paths and 16 deprecated aliases. A mechanical comparison with the pre-refactor document confirms that **no operation and no schema was removed**, and that every old operation keeps its response codes. The field-level changes are additive (`channel`) or loosened (`error.code` enum → string, `ProvisioningSession.network` enum → string). There is no "adapter" terminology and no provider id in the document; a test enforces both.
- The full list is in [API.md → Breaking changes](API.md#breaking-changes-gateway-refactor).

## 5. Database changes

The migration is `0001_gateway_connections`, and it is **metadata-only**:

- `social_connections` → `gateway_connections`, with its primary key, FK and index names renamed to match. No data is copied or rewritten, and ids are unchanged.
- An auto-updatable **compatibility view** `social_connections` is kept for one release.

The ownership chain is unchanged: workspace → gateway connection → Outstand provider account, with `UNIQUE(provider, external_id)`. The `network` columns and every `social_*` capability table keep their names; I avoided any destructive redesign.

Verified by:

- `db:check` and drift, which pass;
- an upgrade test that builds a pre-refactor database with data, migrates it, and checks that rows, FKs, FK enforcement, the view (read and write) and re-run idempotency all hold;
- running the **previous release's full integration suite (58 tests) against the migrated schema**, which all passed. So a rolling deploy and a code rollback are both safe.

## 6. Tests and security

| Check | After refactor |
| --- | --- |
| `pnpm lint`, `pnpm typecheck` | pass |
| `pnpm test` | 18 files passed, 1 skipped; **159 tests passed**, 6 skipped (live suite, opt-in) |
| `pnpm build` | pass |
| `pnpm openapi:check` | up to date (regenerated) |
| `pnpm db:check`, drift generation | consistent / no schema changes |

**Behaviour preservation.** All 58 pre-existing integration tests still pass through the legacy paths, unmodified apart from imports and harness wiring.

**New tests:**

- **Architecture A** (`apps/api/test/gateway.int.test.ts`): a gateway with **no** capability modules still describes itself, reports discovery, provisions accounts, handles `account.token_expired`, stores and ignores unclaimed events, and schedules only gateway jobs. Capability routes are absent (404), and connections are plain `GatewayConnection`s.
- **Architecture B** (`packages/adapters/social-publishing/test/portability.int.test.ts`): the unchanged Social Publishing service creates and publishes a canonical post through an in-memory **non-Outstand** port with its own catalog. The output validates against `SocialPostSchema` and carries no provider ids. This test found a latent bug, now fixed: with an unlimited provider horizon, the hand-off query sent the year `+275760` to PostgreSQL.
- **Static rules** (`test/architecture.test.ts`):
  - the Gateway Contract imports only Zod;
  - capability contracts import only Zod and the contract;
  - gateway-core imports no provider or capability code;
  - only the composition root and `adapters/*/src/outstand` import the Outstand client;
  - canonical services never import adapters;
  - `wire.ts` is private;
  - no package reaches into another's internals;
  - `CapabilityRouter`, `ProviderRegistry`, `providers.get(` and `router.resolve` cannot return.
- **Gateway surface tests:**
  - descriptor, health (no provider traffic), discovery (including cross-workspace isolation);
  - `channel`/`network` handling, canonical versus legacy paths and deprecation headers;
  - OpenAPI deprecation, with no "adapter" or provider-id terms;
  - read and write through the compatibility view.
- **Migration upgrade test** (`packages/database/test/upgrade.int.test.ts`).

**Security posture is unchanged:**

- the same ZS1 authentication (now in gateway-core);
- the same workspace constraints and mapping-only resolution of provider ids;
- the same HMAC webhook verification;
- the same redaction;
- `network_data` still dropped inside the client.

The existing cross-tenant suite passes unchanged. New guarantees are listed in [SECURITY.md](SECURITY.md#architecture-level-guarantees-tests).

**Built artefacts.** Both bundles were started against a fresh database. Migrations applied, `/ready` returned ready, `/v1/gateway`, `/v1/capabilities` and `/v1/gateway/health` returned 200, and the worker wrote heartbeats and enqueued its periodic jobs. The Docker **runtime stage** was simulated with a production-only install from exactly the manifests the Dockerfile copies. `docker build` itself could not run because there is no Docker daemon in this environment.

**Secrets.** No secret entered Git. `.env.example` holds placeholders only, and CI's guard against committed `.env` files still applies.

## 7. Compatibility and deviations from the specification

| Deviation | Why |
| --- | --- |
| Extra package `packages/outstand-gateway` (composition root) | The spec's layout has nowhere to wire config, the channel catalog, the account port and the webhook source without making gateway-core or an adapter provider-aware |
| Extra package `adapters/social-direct-messages` | "Conversations: preserve narrowly". Kept out of publishing and analytics, with no universal inbox |
| Capability contracts live in their capability packages (`./contract` subpath), not separate packages | Keeps each capability self-contained. Import rules keep contracts Zod- and contract-only |
| `SocialPublication.provider` and `SocialConnection.provider` still exposed | Pre-existing diagnostic fields, kept for compatibility (value `"outstand"`, never an id) |
| DB columns `network` and `social_*` table names unchanged; only the connections table renamed | Spec: avoid destructive redesign; prefer additive and safe renames |
| Old paths kept as aliases rather than removed | Preserve behaviour and give Zeptly one release to move. No main-Zeptly changes were made |
| `error.code` typed as an open string in OpenAPI | The error registry is extensible per capability. The emitted codes are unchanged |

## 8. Technical debt

1. **Remove the compatibility view and the legacy HTTP aliases** in the next release or major version (RUNBOOK "Scheduled clean-ups").
2. **Column naming.** `gateway_connections.network` and `provisioning_sessions.network` would ideally become `channel`. This was deferred as a non-essential rename.
3. **Composite context.** `OutstandGatewayContext` intersects every capability context, and the ports are constructed even when a capability is not composed. Module registration uses a variance cast (`as CapabilityModule<OutstandGatewayContext>`). This is harmless but could be tightened with per-module context factories.
4. **Registry disable switch.** The `CapabilityRegistry` supports a disabled set, but it is not exposed through configuration. Disabling a capability today means not composing it.
5. **Analytics coupling.** Social Analytics reads the Social Publishing ledger. This is documented and deliberate, but it means analytics requires publishing.
6. **Job types are plain strings** (the `JOB_TYPES` union is gone). The composition root detects duplicate job types at startup, but there is no compile-time exhaustiveness.
7. **Carried over:**
   - the live Outstand validation is still outstanding;
   - `OUTSTAND_POST_UPDATE_ENABLED` stays `false` until the live PATCH test passes;
   - the deferred Outstand newsletter items listed in [OUTSTAND.md](OUTSTAND.md).

## 9. Railway readiness

The service topology, config-as-code files, start and pre-deploy commands, health checks and **all environment variables are unchanged**. The Dockerfile's manifest list was updated for the new package layout. Migration 0001 is instant and safe for a rolling deploy (§5).

Readiness was verified locally only:

- CI-equivalent checks;
- built bundles running against PostgreSQL;
- a simulated production image tree.

**Not performed:** a Railway deployment, a real `docker build`, and live Outstand calls. The post-deploy verification steps in [RAILWAY.md](RAILWAY.md#verification-after-deploy) now include `GET /v1/gateway` and `GET /v1/capabilities`.

## Recommendations for a future Zernio Gateway

1. **Build it as a separate gateway, not as a second provider here.** Give it its own service and database, implementing Gateway Contract v1: `/v1/gateway`, `/v1/capabilities`, `/v1/connections`, `/v1/provisioning`, the canonical errors and the webhook envelope. Zeptly discovers both gateways and routes per workspace or capability. Do not reintroduce routing inside either gateway.
2. **Reuse, don't fork.** Depend on `gateway-contract` and `gateway-core` unchanged. Promote them (and the capability packages) to a shared, versioned package source when the second gateway starts. Today they live in this repository's workspace.
3. **Write a `zernio-client`** that mirrors `outstand-client`: private wire schemas, typed sanitized results, `ZernioError extends UpstreamError`, rate-limit awareness, and webhook verify and parse. Add the same architecture rules.
4. **Implement ports, not new domains:**
   - `SocialPublishingPort` for Zernio posting, with its own `NetworkCatalog`. Networks beyond `SOCIAL_NETWORKS` need an **additive** contract change: extend the enum under a minor contract version, or move to a `social.publishing@2` with an open channel list;
   - `SocialAnalyticsPort` if Zernio's analytics exceed "basic". Richer analytics should be a new capability id (for example `social.analytics.advanced@1`), not a mutation of `basic`;
   - `ProviderAccountPort` and a `WebhookSource` that maps Zernio events to the existing kinds.
5. **Keep ownership rules identical:**
   - an opaque tenant ref per workspace;
   - state-token-bound provisioning;
   - `UNIQUE(provider, external_id)`;
   - mapping-only resolution of inbound ids.

   Copy the cross-tenant, architecture A/B and upgrade tests first.
6. **Capabilities Outstand lacks** (comments, ads, inbox on more networks) must arrive as **new versioned capability contracts** with their own paths under `/v1/social/...`. They should not be optional fields bolted onto existing objects.
7. **Zeptly-side selection.** Give Zeptly a small gateway registry of `{ gatewayId, baseUrl, secret }`. Zeptly should cache `GET /v1/gateway` and choose per workspace using `GET /v1/capabilities`. A connection belongs to exactly one gateway, so Zeptly stores `(gatewayId, connectionId)` pairs.
