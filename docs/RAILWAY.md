# Railway deployment

## Topology

Deployed project: **`outstand-gateway`** (Railway workspace "My Projects", region `ams`, environment `production`).

| Service | Source | Start | Pre-deploy | Health check | Restart | Public |
| --- | --- | --- | --- | --- | --- | --- |
| **Postgres** | Railway PostgreSQL template (`postgres-ssl:18`, volume `postgres-volume`) | — | — | — | — | no (private network only) |
| **API** | GitHub `Zeptly/Social-Channels-Adaptor`, `Dockerfile` | `node apps/api/dist/main.js` | `node apps/api/dist/migrate.js` | `GET /ready` (120 s) | ON_FAILURE ×10 | `https://api-production-97c0.up.railway.app` |
| **Worker** | GitHub `Zeptly/Social-Channels-Adaptor`, `Dockerfile` | `node apps/worker/dist/main.js` | `node apps/worker/dist/migrate.js` | — (no HTTP) | ALWAYS | no |

Both app services build the same `Dockerfile` (Node 24, pnpm, bundled workspace packages, production dependencies only). Migrations are idempotent and serialized with a PostgreSQL advisory lock, so both pre-deploy steps can run safely. The worker also waits for migrations on boot. Each service has scoped watch patterns (`apps/<service>/**`, `packages/**`, `migrations/**`, `package.json`, `pnpm-lock.yaml`, `Dockerfile`), so a worker-only change does not redeploy the API.

**Service settings live on the Railway services**, not in the repository. Railway deprecated Config as Code (`railway.toml`), and new services cannot opt into it, so the former `railway.toml` / `railway/*.toml` files were removed in Phase 2. That also removes the risk of the worker picking up the API's root config. The table above is the authoritative record of those settings.

## Setup steps (as performed in Phase 2)

1. **Project.** Create the `outstand-gateway` project.
2. **PostgreSQL.** Add the PostgreSQL template.
3. **API service.** Create an empty service `API` and set the settings in the table (Dockerfile path `Dockerfile`, start, pre-deploy, health check, restart, watch patterns). Generate a Railway domain. Set the variables below.
4. **Worker service.** Create an empty service `Worker` with its settings from the table, and no domain. Set its variables, mostly as references to the API's (`${{API.…}}`), so each secret has one source of truth.
5. **Secrets.** Set `OUTSTAND_API_KEY` and `OUTSTAND_WEBHOOK_SECRET` on the **API** service in the Railway dashboard. They are never committed and never pasted into chats or tickets.
6. **Source.** Connect both services to the GitHub repository and branch. Each push to the branch deploys the affected services.
7. **Outstand webhook.** In the Outstand dashboard, add the webhook endpoint `https://<api-domain>/v1/webhooks/outstand` with the signing secret set as `OUTSTAND_WEBHOOK_SECRET`. Outstand's *Test* action should then show a `processed` test event in `GET /v1/admin/webhook-events`.

## Variables

| Variable | API | Worker | Secret | Value |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | ✓ | ✓ | | `production` |
| `DATABASE_URL` | ✓ | ✓ | ✓ | `${{Postgres.DATABASE_URL}}` (private network) |
| `ZEPTLY_SERVICE_SECRET` | ✓ | ✓ | ✓ | `openssl rand -base64 48`; the same value is configured in Zeptly |
| `ZEPTLY_SERVICE_SECRET_PREVIOUS` | ✓ | | ✓ | Only during rotation |
| `OUTSTAND_API_KEY` | ✓ | ✓ | ✓ | Outstand PAYG API key |
| `OUTSTAND_WEBHOOK_SECRET` | ✓ | ✓ | ✓ | Signing secret configured in Outstand |
| `OUTSTAND_API_BASE_URL` | ✓ | ✓ | | `https://api.outstand.so/v1` |
| `OUTSTAND_SCHEDULING_HORIZON_DAYS` | ✓ | ✓ | | `30` |
| `OUTSTAND_HANDOFF_MARGIN_MINUTES` | ✓ | ✓ | | `60` (optional) |
| `OUTSTAND_POST_UPDATE_ENABLED` | ✓ | ✓ | | `false`; set `true` only after the live PATCH test passes |
| `PUBLIC_BASE_URL` | ✓ | ✓ | | `https://${{RAILWAY_PUBLIC_DOMAIN}}` on the API; the API's value on the worker |
| `ALLOWED_RETURN_URL_ORIGINS` | ✓ | ✓ | | Zeptly web origin(s), comma-separated, e.g. `https://app.zeptly.com` |
| `API_PORT` / `PORT` | ✓ | | | Railway injects `PORT`; `API_PORT` overrides it |
| `LOG_LEVEL` | ✓ | ✓ | | `info` |
| `WORKER_CONCURRENCY` | | ✓ | | `4` (optional) |
| `WORKER_POLL_INTERVAL_MS` | | ✓ | | `2000` (optional) |
| `OUTSTAND_LIVE_TESTS` | | | | `false` (only for the manual live suite, never in production) |

The worker needs `PUBLIC_BASE_URL` and `ALLOWED_RETURN_URL_ORIGINS` only because both services share one configuration schema. It serves no HTTP.

Configuration is validated at startup, and the process exits with a message listing every missing or invalid variable. In production, `PUBLIC_BASE_URL` must be https and `ALLOWED_RETURN_URL_ORIGINS` must not be empty.

No secret is committed; CI blocks committed `.env` files.

## Verification after deploy

```bash
curl -s https://<api-domain>/health          # {"status":"ok"}
curl -s https://<api-domain>/ready           # database, migrations, configuration all ok
ZS_BASE_URL=https://<api-domain> ZEPTLY_SERVICE_SECRET=… ZS_WORKSPACE=ws_payg_test pnpm zs GET /v1/capabilities
ZS_BASE_URL=https://<api-domain> ZEPTLY_SERVICE_SECRET=… pnpm zs GET /v1/gateway --no-workspace
ZS_BASE_URL=https://<api-domain> ZEPTLY_SERVICE_SECRET=… pnpm zs GET /v1/admin/jobs --no-workspace
```

Worker health: its logs show `worker started` and periodic `job completed` lines. The `worker_heartbeats` table is updated every tick.

## Upgrading to the gateway refactor

- **No new or renamed environment variables.** The service topology, config files, start commands and health checks are unchanged. Log `service` names changed to `outstand-gateway-api` and `outstand-gateway-worker`, and the PostgreSQL `application_name` changed to `outstand-gateway`.
- **Migration `0001_gateway_connections`** runs as the pre-deploy step. It is metadata-only: it renames `social_connections` to `gateway_connections` plus its constraints and index, and it copies no data, so it completes instantly. It then creates a `social_connections` compatibility view so a previous-release process still running during the rollover keeps reading and writing (the view is auto-updatable).
- **Rollback.** Code rollback to the previous release stays safe while the view exists, because the old code addresses `social_connections`. This was verified by running the previous release's full integration suite (58 tests) against a database migrated to 0001: all passed. If a full schema rollback is ever required, run `DROP VIEW social_connections; ALTER TABLE gateway_connections RENAME TO social_connections;` and rename the constraints and index back (see `migrations/0001_gateway_connections.sql`).
- **Follow-up in the next release:** add a migration that drops the `social_connections` view (RUNBOOK "Scheduled clean-ups").

## Rollback

Redeploy the previous deployment in Railway. The V1 migration is additive, and future migrations must stay backward compatible for one release, so the API and worker can be rolled back independently.
