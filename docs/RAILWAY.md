# Railway deployment

## Topology

| Service | Source | Config file | Start | Pre-deploy | Health check | Restart |
| --- | --- | --- | --- | --- | --- | --- |
| **PostgreSQL** | Railway Postgres plugin | — | — | — | — | — |
| **API** | this repo (Dockerfile) | `railway.toml` (or `railway/api.toml`) | `node apps/api/dist/main.js` | `node apps/api/dist/migrate.js` | `GET /ready` (120 s) | ON_FAILURE ×10 |
| **Worker** | this repo (Dockerfile) | `railway/worker.toml` | `node apps/worker/dist/main.js` | `node apps/worker/dist/migrate.js` | — (no HTTP) | ALWAYS |

Both app services build the same `Dockerfile` (Node 24, pnpm, bundled workspace packages, production dependencies only). Migrations are idempotent and serialized with a PostgreSQL advisory lock, so both pre-deploy steps can run safely. The worker also waits for migrations on boot. Each service deploys independently: `watchPatterns` are scoped, so a worker-only change does not redeploy the API.

## Exact setup steps

These steps require a human with Railway access. The build environment could not reach Railway (egress blocked), so nothing has been deployed yet.

1. **Project.** Create a Railway project (or use the target project) named e.g. `outstand-gateway`.
2. **PostgreSQL.** Add a PostgreSQL database service (*New → Database → PostgreSQL*).
3. **API service.**
   - Go to *New → GitHub Repo → `Zeptly/Social-Channels-Adaptor`* and choose the production branch (`main` after merge).
   - *Settings → Config-as-code*: path `railway.toml` (the default).
   - *Settings → Networking*: *Generate Domain*, or attach a custom domain such as `social.zeptly.com`.
   - Turn on *Wait for CI* (deploy only after GitHub checks pass).
4. **Worker service.** Add the same repo a second time. Set *Config-as-code* to `railway/worker.toml` and do not generate a domain.
5. **Variables.** Set the variables below. Use Railway references for shared values: on the worker, set `DATABASE_URL=${{Postgres.DATABASE_URL}}` and reference the API's secrets, e.g. `OUTSTAND_API_KEY=${{API.OUTSTAND_API_KEY}}`.
6. **Deploy.** Deploy the API, then the worker. Check that `https://<api-domain>/ready` returns `{"status":"ready"}`.
7. **Outstand webhook.** In the Outstand dashboard, add the webhook endpoint `https://<api-domain>/v1/webhooks/outstand` with a signing secret, and set that secret as `OUTSTAND_WEBHOOK_SECRET` on both services. Use the dashboard's *Test* action: `GET /v1/admin/webhook-events` should then show a `processed` test event.

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

No secret is committed: `railway.toml` and `railway/worker.toml` contain only build and deploy settings, and CI blocks committed `.env` files.

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
