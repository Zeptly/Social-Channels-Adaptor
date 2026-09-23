# Security

## Trust boundaries

| Party | Trusted for | Never trusted for |
| --- | --- | --- |
| Zeptly backend (signed) | Identifying the workspace and caller | Asserting ownership of connections/posts/provider ids |
| Outstand API | Provider state (after authenticated GET) | Workspace ownership |
| Outstand webhooks (signed) | Event facts about provider references we already map | Establishing ownership; unknown references are ignored |
| End-user browser (callback) | Nothing beyond presenting the state token | — |

## Service-to-service authentication (Zeptly → Zeptly Social)

Scheme `ZS1-HMAC-SHA256` with the shared `ZEPTLY_SERVICE_SECRET` (≥ 32 chars). Implemented in `apps/api/src/auth.ts`.

Headers: `X-Zeptly-Caller`, `X-Zeptly-Workspace-Id` (workspace routes), optional `X-Zeptly-Agent`, `X-Zeptly-Timestamp` (unix seconds, ±300 s), `X-Zeptly-Signature: v1=<hex>`, optional `X-Request-Id`.

```
canonical = "ZS1\n" + timestamp + "\n" + METHOD + "\n" + path+query + "\n"
          + workspaceId + "\n" + caller + "\n" + agent + "\n" + hex(sha256(raw body))
signature = "v1=" + hex(HMAC-SHA256(ZEPTLY_SERVICE_SECRET, canonical))
```

- The workspace, caller, agent, path, method and body are all signed, so a captured request cannot be replayed against another workspace, path or body (tested).
- The workspace comes only from the signed header. No route accepts a workspace id in the path or body, so a mismatch between the two cannot occur.
- Routes are `workspace` (default), `service` (`/v1/admin/*`: authenticated, no workspace, diagnostics only) or `public` (`/health`, `/ready`, `/openapi.json`, `/v1/webhooks/outstand` which is HMAC-verified, and `/v1/connect/callback/:state` which is state-token bound).
- **Replay window.** A request can be replayed verbatim within ±5 minutes. Mutating commands are nevertheless idempotent (Idempotency-Key), so a replay cannot create duplicates.
- **Migration path.** `ServiceAuthenticator` is an interface. An asymmetric implementation (Ed25519-signed requests, or JWT service identity verified against a JWKS) can replace `HmacServiceAuthenticator` in `apps/api/src/main.ts` without changing any endpoint.

### Key rotation

1. Generate a new secret: `openssl rand -base64 48`.
2. On Zeptly Social (API service), set `ZEPTLY_SERVICE_SECRET_PREVIOUS=<old>` and `ZEPTLY_SERVICE_SECRET=<new>`, then redeploy. Both secrets are now accepted.
3. Switch Zeptly to sign with the new secret, and deploy Zeptly.
4. Remove `ZEPTLY_SERVICE_SECRET_PREVIOUS` and redeploy.

The Outstand webhook secret rotates by updating it in Outstand's webhook settings and in `OUTSTAND_WEBHOOK_SECRET` together. Deliveries sent during the gap fail with 401 and are retried by Outstand. Rotate the Outstand API key in the Outstand dashboard, then update `OUTSTAND_API_KEY` on both services.

## Workspace isolation

- Every tenant-owned row has `workspace_id`. Every service function takes the authenticated `Actor` and filters by `workspace_id`. Tenancy guards live in `packages/core/src/tenancy.ts`.
- `request workspace → social connection → provider account mapping → operation` is verified on every provider operation. The join requires `provider_accounts.workspace_id = social_connections.workspace_id = actor workspace`.
- `provider_accounts` has `UNIQUE(provider, external_id)`. A provider account belongs to at most one workspace. Provisioning that returns an account already owned elsewhere is refused (`CONNECTION_OWNERSHIP_CONFLICT`) and audited.
- Ownership is never inferred from network or username. Adoption during reconciliation requires both the workspace's opaque tenant ref and a recent provisioning session for that network.
- Other workspaces' resources return **404**, not 403. There is no existence oracle.
- Webhooks resolve provider references only through stored mappings. Unknown references are ignored.
- Automated cross-tenant tests are in `apps/api/test/security.int.test.ts`. They cover connections, posts, schedules, publications, media, metrics, conversations, messages, raw provider ids used as connection ids, ownership-conflict adoption, and webhooks for another tenant's account.

## Provider credentials and secrets

- `OUTSTAND_API_KEY` and `OUTSTAND_WEBHOOK_SECRET` are server-side environment variables only. They never reach Zeptly or any browser.
- Bluesky app passwords (credentials strategy) are forwarded once over TLS and **never persisted or logged**. The redaction key list covers `appPassword`, `app_password` and `credentials`.
- Outstand's pending-session handle is stored only for the short provisioning window and cleared on completion or expiry. The OAuth state token is stored only as a SHA-256 hash.
- Outstand post responses embed per-network OAuth tokens (`network_data`). The adapter's allowlist mapping drops them. Tests assert they never reach responses or the database.

## Logging and redaction

Pino JSON logs, implemented in `packages/observability`:

- Key-based redaction: authorization, cookie, signatures, token, password, secret, credentials, `network_data`, `upload_url`, and similar keys.
- Value-based redaction of registered secrets: the API key, webhook secret and service secrets.
- Pattern redaction: `Bearer …`, `postgres://user:pass@`, and `?session=`, `?signature=` and `X-Amz-*` query values.
- Request URLs are logged with the callback state token and query secrets scrubbed.
- Stored webhook payloads are redacted and purged after 30 days. Provider error messages are redacted and truncated before they are persisted or returned under `details.provider`.

## Webhook security

HMAC-SHA256 over the raw bytes in constant time, with the `sha256=<64 hex>` format required. An invalid signature gets 401 and nothing is stored or processed. Receipts are deduplicated by a unique event identity. Only posts created by this service can trigger an Outstand call, which is the amplification protection. The service refuses to start without `OUTSTAND_WEBHOOK_SECRET` (fail closed).

## Other controls

- **SSRF.** Media URLs must be HTTPS and public. The host is DNS-resolved and checked against private, loopback, link-local, CGNAT and multicast ranges. Redirects are not followed and sizes are capped while streaming.
- **Open redirect.** Provisioning `returnUrl` origins must be listed in `ALLOWED_RETURN_URL_ORIGINS`, which is required in production.
- **Body size.** 1 MB JSON limit. Validation is strict Zod, and unknown option keys are rejected.
- **Audit.** `audit_events` records connection initiated/established/reconnect-required/removed, post accepted, publication requested/succeeded/failed/partial, schedule created/changed, cancellations, messages sent/failed and reconciliation changes. Each event carries the calling service, `X-Zeptly-Agent` and the request id. Content bodies and credentials are never stored in audit metadata.

## Known residual risks

- **Shared secret.** Anyone holding `ZEPTLY_SERVICE_SECRET` can act for any workspace. That is inherent to service-to-service trust: Zeptly owns user permissions. Protect the secret and migrate to asymmetric identity when needed.
- **Admin routes** use the same service credential. They expose diagnostics only, not tenant content.
- **No request rate limiting in V1.** Railway's edge and the Zeptly caller are trusted. Webhook signature verification is cheap and happens before any database write.
