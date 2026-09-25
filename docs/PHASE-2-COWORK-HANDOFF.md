# Phase 2 handoff to Cowork: finish the Outstand Gateway deployment

Prepared 2026-09-25 by the Claude Code session that built Phase 1 and started Phase 2. **No secret values are in this file.**

---

## 1. Prompt to paste into Cowork

> You are finishing **Phase 2 — Outstand Gateway Validation & Railway Deployment** for Zeptly. The Phase 2 specification (PDF "Phase 2 — Outstand Gateway Validation & Railway Deployment") is authoritative, and the attached `PHASE-2-COWORK-HANDOFF.md` records exactly what is already done. Read both before acting, and commit the handoff file to `docs/` in `github.com/Zeptly/Social-Channels-Adaptor` (branch `claude/zen-babbage-y7g3sy`) with your first change.
>
> **Already done:**
> - The architecture gate passed with no code corrections.
> - The local validation baseline is green: 159 tests.
> - The Railway project `outstand-gateway` has Postgres, API and Worker deployed from commit `fcdb3b5`, and both services are running.
>
> **Your job:**
> 1. Replace the two temporary Outstand values in Railway with the real ones, and configure the Outstand webhook.
> 2. Verify the deployed API over HTTPS: health, service auth, discovery, OpenAPI and webhook signatures.
> 3. Run the controlled live vertical slice with a safe test account: connect → publish or schedule → webhook → worker → reconciliation → canonical state.
> 4. Run the reliability, scheduling, security and capability checks listed in §5 of the handoff.
> 5. Update the docs to match deployed reality, and create `docs/PHASE-3-HANDOFF.md` and `docs/PHASE-2-REPORT.md`.
> 6. Tag the validated commit `outstand-gateway-v1.0.0`, and record Gateway Contract v1 as frozen.
>
> **Rules:**
> - Never commit, log or paste secrets.
> - Never weaken webhook signature verification.
> - No public posting unless the account owner explicitly approves it.
> - Do not modify main Zeptly. No Zernio, BYOK, new Outstand scope, frontend or unrelated refactoring.
> - Change code only for demonstrated, deployment-blocking defects, and add a regression test when you do.
> - In every report, label each result as **live provider validation**, **deployed-infrastructure validation**, **automated/mocked test**, or **not validated**. Never report mocked or unexecuted work as live.

---

## 2. Current state (verified 2026-09-25)

### Repository

| Item | Value |
| --- | --- |
| Repo / branch | `Zeptly/Social-Channels-Adaptor` @ `claude/zen-babbage-y7g3sy` (there is no `main` yet) |
| Deployed commit | `fcdb3b5`: "Phase 2: move Railway settings to the services…" (on top of `4b9286b`, the Phase 1 refactor) |
| Phase 1 report | `docs/REFACTOR-REPORT.md` |
| Contract docs | `docs/GATEWAY-CONTRACT.md`, `docs/API.md`, `openapi/openapi.json` |
| Deployment doc | `docs/RAILWAY.md` (service settings live on the Railway services; `railway.toml` was removed because Railway deprecated it) |

### Railway

| Item | Value |
| --- | --- |
| Workspace | "My Projects" (account `chrismarchant`) |
| Project | `outstand-gateway`, id `d62f46d0-0b00-49d2-b49e-2d34188d219d` |
| Environment | `production`, id `c553271e-01dd-415b-911a-aae61addf14d`, region `ams` |
| Postgres | service `e348c091-27c5-473f-ba88-4b299fedf3d0`, image `postgres-ssl:18`, private network only |
| API | service `6e5e5ebb-0ee1-497a-b9d7-c09e8dcfc390`, **`https://api-production-97c0.up.railway.app`** |
| Worker | service `e04293ed-cb93-4624-8044-88f285a36d25`, no public domain |
| Deploy source | both services follow GitHub `Zeptly/Social-Channels-Adaptor` branch `claude/zen-babbage-y7g3sy` (a push redeploys them) |

API settings:
- Dockerfile `Dockerfile`.
- Start `node apps/api/dist/main.js`; pre-deploy `node apps/api/dist/migrate.js`.
- Health check `/ready` with a 120 s timeout; restart ON_FAILURE ×10.

Worker settings:
- Start `node apps/worker/dist/main.js`; pre-deploy `node apps/worker/dist/migrate.js`.
- Restart ALWAYS.

**Variables on the API service:**
- `NODE_ENV=production`
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `ZEPTLY_SERVICE_SECRET`: generated for this deployment. Read it from Railway when you need to sign requests, and **rotate it before Zeptly integration** (see §7).
- `OUTSTAND_API_BASE_URL=https://api.outstand.so/v1`
- `OUTSTAND_SCHEDULING_HORIZON_DAYS=30`
- `OUTSTAND_HANDOFF_MARGIN_MINUTES=60`
- `OUTSTAND_POST_UPDATE_ENABLED=false`
- `PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`
- `ALLOWED_RETURN_URL_ORIGINS=https://${{RAILWAY_PUBLIC_DOMAIN}}`
- `LOG_LEVEL=info`
- `OUTSTAND_API_KEY` = **TEMPORARY placeholder `pending-real-outstand-key`**
- `OUTSTAND_WEBHOOK_SECRET` = **TEMPORARY random value** (not a real Outstand secret)

The **Worker** references the API's values (`${{API.…}}`) for every shared setting, and additionally sets `WORKER_CONCURRENCY=4` and `WORKER_POLL_INTERVAL_MS=2000`. Setting the real values on the API service therefore updates both services.

### What is already validated

**Local and CI-equivalent** (automated and mocked; Outstand is faked):
- Install, lint and typecheck pass.
- 92 unit and 67 integration tests pass, 6 live tests are skipped (opt-in).
- The build passes, and `openapi:check` is up to date.
- `db:check` passes, with no drift, and migrate-twice is idempotent.
- Config validation fails fast in the built bundles.
- The production dependency audit is clean (only dev-tool esbuild advisories remain).
- There are no secrets in the Git history.
- The architecture tests pass: A (a gateway without capabilities is still coherent), B (Social Publishing runs on a non-Outstand port), and the static import rules.
- The previous release's integration suite passes against the migrated schema, so rollback is safe.

**Deployed infrastructure** (from the Railway logs):
- The real Docker build succeeded for both services.
- Pre-deploy migrations ran on PostgreSQL 18 (`[migrate] done` for both services).
- The API booted and Railway's `/ready` health check returned 200.
- The Worker booted, wrote to the DB, and ran `housekeeping`, `reconcile_publications`, `ingest_metrics` and `sync_conversations` successfully.
- `reconcile_connections` reached Outstand's real API and was rejected (expected with the placeholder key). It was marked dead immediately as `PROVIDER_UNAVAILABLE` (a non-retryable credential error), and no secret appeared in the logs.

**Not yet validated:**
- Any HTTP request to the deployed API from outside Railway: auth, discovery, OpenAPI, webhooks.
- Anything that needs real Outstand credentials.
- Worker restart recovery on Railway.
- The live vertical slice, live scheduling hand-off, live webhooks, and the reauthorization state.

### Blockers the previous session could not clear

1. **GitHub push** from the Claude Code session was denied (403). The Claude GitHub App lacks write access on the Zeptly repo. The owner pushed manually from Termux.
2. **Network**: the Claude Code session's network policy blocked `*.up.railway.app`, so the deployed API could not be called from there.

---

## 3. Required human inputs (ask the owner; never ask them to paste secrets into chat)

1. **Outstand API key.** Set it in the Railway dashboard → API service → Variables → `OUTSTAND_API_KEY`.
2. **Outstand webhook.** In the Outstand dashboard, create an endpoint `https://api-production-97c0.up.railway.app/v1/webhooks/outstand`. Put its signing secret into `OUTSTAND_WEBHOOK_SECRET` on the Railway API service. If Outstand lets you choose the secret, generate one with `openssl rand -hex 32`.
3. **Safe test account** on one supported network (LinkedIn, Instagram, Facebook, Threads, TikTok, Pinterest, YouTube or Bluesky). Bluesky can connect with a handle and app password (`credentials` strategy), so no OAuth redirect is needed; the owner must enter the app password themselves. Otherwise the owner completes one OAuth consent in a browser.
4. **Publishing permission.** Is an immediate public post to that test account acceptable? If not, use the **schedule-then-cancel** path only.

Saving the variables redeploys both services. Confirm that both new deployments reach SUCCESS before continuing.

---

## 4. How to call the deployed API

Requests are signed **ZS1-HMAC-SHA256**; `docs/SECURITY.md` has the scheme. The repo includes a CLI:

```bash
pnpm install
export ZS_BASE_URL=https://api-production-97c0.up.railway.app
export ZEPTLY_SERVICE_SECRET='<read from Railway API variables; do not echo or log>'
export ZS_WORKSPACE=ws_phase2_validation      # synthetic test workspace
pnpm zs GET /v1/gateway --no-workspace
pnpm zs GET /v1/capabilities
pnpm zs POST /v1/social/publishing/posts '{"content":{"text":"…"},"targets":[{"connectionId":"<id>"}]}' --idem
```

- Health endpoints need no auth: `curl $ZS_BASE_URL/health` and `curl $ZS_BASE_URL/ready`.
- Admin diagnostics need no workspace: `pnpm zs GET /v1/admin/jobs?status=dead --no-workspace` and `pnpm zs GET /v1/admin/webhook-events --no-workspace`.
- To sign a synthetic webhook, compute `X-Outstand-Signature: sha256=<hex HMAC-SHA256(raw body, OUTSTAND_WEBHOOK_SECRET)>`. Use this only for negative and duplicate tests: a bad signature must return 401. Otherwise, prefer Outstand's own **Test** delivery.
- Use the **canonical paths** (`/v1/social/publishing/...`). The old `/v1/posts` etc. are deprecated aliases.

---

## 5. Remaining Phase 2 work (maps to the spec's Definition of Done)

Record evidence for each item: request, response code and body (secrets redacted), log lines, and DB state from admin endpoints. Label each as live, deployed-infrastructure, mocked, or not validated.

### A. Deployed API (spec §8)

- [ ] `/health` returns 200. `/ready` returns 200 with checks `database`, `migrations` ("2 applied") and `configuration`.
- [ ] Unsigned `GET /v1/gateway` → 401 `AUTHENTICATION_FAILED`. Bad signature → 401. Stale timestamp (older than 300 s) → 401.
- [ ] `GET /v1/gateway` returns `gatewayContractVersion: "1"` with capabilities `social.publishing@1`, `social.scheduling@1`, `social.analytics.basic@1` and `social.direct_messages@1`.
- [ ] `GET /v1/gateway/health` returns 200 and makes no Outstand calls (check the logs).
- [ ] `GET /v1/capabilities` for a new workspace reports every capability `available:false`, because there are no connections.
- [ ] `GET /openapi.json` matches the committed `openapi/openapi.json`; diff them.
- [ ] Logs are structured JSON with `reqId`, `workspaceId` and `caller`, and contain no secrets.

### B. Webhooks (spec §10)

- [ ] The Outstand dashboard **Test** delivery → 200, and `admin/webhook-events` shows it as `processed`.
- [ ] Invalid and missing signatures → 401, and nothing is stored.
- [ ] Redelivering the same event → `{"duplicate":true}`, with no second state transition.
- [ ] An event for an unknown account or post → stored as `ignored`, with no ownership created.

### C. Live vertical slice (spec §11)

1. [ ] Connect the safe account:
   - Bluesky: `POST /v1/connections {"channel":"bluesky","credentials":{…}}`, sent by the owner.
   - Other networks: `POST /v1/connections {"channel":"<net>","returnUrl":"https://api-production-97c0.up.railway.app/return"}`, then the owner opens `authorizationUrl`. The return page may 404; only the `provisioningId` query parameter is needed. Finish with `GET /v1/provisioning/{id}` and `POST …/finalize` if the status is `awaiting_selection`.
2. [ ] `GET /v1/connections` shows a canonical SocialConnection with no Outstand ids, and `GET /v1/capabilities` now shows it as available.
3. [ ] **Schedule-then-cancel** (always safe):
   - Create a post, then `POST …/posts/{id}/schedule` with `scheduledAt` about 2 days ahead, which is inside the horizon.
   - `GET …/publications` shows `accepted`, meaning it was handed to Outstand. `POST …/cancel` then deletes it at Outstand.
4. [ ] **Only with owner approval:** publish now, wait for the Outstand webhook, let the worker reconcile, and check that `GET …/posts/{id}` shows `published` with `platformPostUrl`.
5. [ ] Analytics: `POST /v1/social/analytics/posts/{id}/refresh`. The result may be empty; record it as-is.

### D. Reliability (spec §12)

- [ ] Idempotency: repeat the create and publish calls with the same `Idempotency-Key` → the response is replayed, and Outstand shows one post.
- [ ] Duplicate webhook (B above).
- [ ] Ambiguous outcome: the automated tests cover this (`apps/api/test/reliability.int.test.ts`). Do not try to force it live; label it **mocked**.
- [ ] Worker restart: enqueue work (for example schedule a post, or `POST /v1/admin/reconcile`), restart the Worker in Railway, and confirm its jobs complete afterwards via `admin/jobs` and the logs.
- [ ] Partial failure: automated coverage exists. Test live only if two safe accounts exist; otherwise label it **mocked**.
- [ ] Reauthorization: live only if revoking the test account's token is safe; otherwise **mocked** (covered by the `account.token_expired` tests).

### E. Scheduling (spec §13)

- [ ] Schedule about 40 days ahead, which is beyond the 30-day horizon. `publications` must stay `pending`, and nothing is sent to Outstand.
- [ ] Accelerated hand-off without code changes: temporarily set `OUTSTAND_SCHEDULING_HORIZON_DAYS` to a larger value (≤ 365) or reschedule inside the window. The next worker hand-off tick (every 60 s) should submit it once. Then cancel it, and restore the variable to `30`.

### F. Security and capabilities (spec §§14–15)

- [ ] A second workspace cannot read or modify the first workspace's connection, post or media: it gets 404, not 403.
- [ ] Using a raw provider id as a connection id → 404.
- [ ] API responses contain no `externalId`, token or `network_data`.
- [ ] `audit_events` context is present. Audit rows aren't exposed over the API; use the logs and job state, or read-only DB access through Railway if available.
- [ ] Discovery lists only the four implemented capabilities, with no inbox, Zernio or entitlement semantics. Document that `available` means "usable on this gateway now", not "Zeptly plan entitlement".

### G. Freeze and deliverables (spec §§17–18, 21)

- [ ] Update `docs/RAILWAY.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md` and `README.md` to match deployed reality (URL, services, variables, what was validated).
- [ ] Add a "Frozen for Phase 3 on <date> at <commit>" note to `docs/GATEWAY-CONTRACT.md`. Breaking changes now require a new version.
- [ ] Create `docs/PHASE-3-HANDOFF.md`. It should describe only the actual integration surface:
  - contract and capability versions;
  - ZS1 auth;
  - `/v1/gateway` and `/v1/capabilities`;
  - the workspace header and id rules;
  - the publishing, scheduling and analytics contracts and paths;
  - canonical errors and idempotency;
  - post, target and publication states;
  - the OpenAPI location;
  - the service URL and required Zeptly-side config (base URL, service secret, caller id);
  - known limitations.

  Do not design Phase 3.
- [ ] Create `docs/PHASE-2-REPORT.md` covering every heading in spec §21, with the live/mocked labels.
- [ ] Commit, push, and tag the validated commit: `git tag -a outstand-gateway-v1.0.0 -m "…" && git push origin outstand-gateway-v1.0.0`.

---

## 6. Guardrails

- Change code only for demonstrated defects that block deployment or validation. Add a regression test for each, re-run `pnpm check` (plus `pnpm db:check` and the drift check), and record the change in the report.
- **Never** loosen `verifySignature`, the service auth, or the tenant checks to make a test pass.
- Railway service settings are the source of truth; there is no `railway.toml`. Record any setting change in `docs/RAILWAY.md`.
- Pushing to the branch redeploys both services. Watch that each deployment reaches SUCCESS.
- Known architectural concerns are recorded for Phase 3 and must not be "fixed" in Phase 2:
  - `ProvisioningSession.network` is a deprecated social alias inside the generic contract.
  - The 23 h ambiguous-retry window is derived from Outstand's 24 h idempotency-key memory.

---

## 7. Clean-up before Zeptly integration

- **Rotate `ZEPTLY_SERVICE_SECRET`.** Its value passed through a Claude Code session during setup. Follow the steps in `docs/SECURITY.md`, then configure the new value in Zeptly.
- Make sure no temporary placeholder values remain in Railway.
- Decide `ALLOWED_RETURN_URL_ORIGINS`. It is currently the gateway's own origin, for testing; set it to the real Zeptly web origin(s) before Phase 3.
- Optional: remove the local `outstand-gateway-refactor.bundle`. It is not committed and is no longer needed now that the commits are pushed.
