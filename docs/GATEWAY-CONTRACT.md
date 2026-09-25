# Gateway Contract v1

The Gateway Contract is what **every** Zeptly provider gateway implements, whatever its provider. It is defined in `packages/gateway-contract` (TypeScript + Zod, no other dependencies), and this document is its normative description. `GATEWAY_CONTRACT_VERSION = "1"`.

The contract is deliberately small. It covers identity, workspaces, provider references, request context, idempotency, capability descriptors, canonical errors, health, connections and provisioning, and the audit and webhook envelopes. It defines **no** capability domain objects: no social post, conversation, SMS, broadcast, analytics metric or provider-account object. Those belong to capability contracts such as Social Publishing v1, which build on this one.

## 1. Gateway interface

```ts
interface Gateway {
  describe(): GatewayDescriptor;                                  // GET /v1/gateway
  capabilities(workspaceId: string): Promise<CapabilityAvailability[]>; // GET /v1/capabilities
  health(): Promise<GatewayHealth>;                               // GET /v1/gateway/health
}
```

### Identity and descriptor

```json
{
  "gateway": "outstand",
  "provider": "outstand",
  "displayName": "Outstand Gateway",
  "gatewayContractVersion": "1",
  "version": "1.0.0",
  "capabilities": [
    { "id": "social.publishing", "version": "1", "enabled": true, "title": "…", "description": "…" }
  ],
  "channels": ["linkedin", "instagram", "…"]
}
```

- `gateway`: stable id (`^[a-z][a-z0-9-]{1,31}$`). There is **one upstream provider per gateway** (`provider`).
- `capabilities`: versioned capability ids. The id pattern is `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, for example `social.publishing`, `social.scheduling` or `social.analytics.basic`. A capability's `version` is the version of its capability contract.
- `channels`: kinds of provider account the gateway can provision. For social gateways a channel is a network.

### Capability discovery (per workspace)

`CapabilityAvailability` is `CapabilityDescriptor` plus:

| Field | Meaning |
| --- | --- |
| `available` | Enabled **and** the workspace has at least one active connection (`connected` or `degraded`) on a supported channel |
| `channels` | Channels on which the gateway offers the capability |
| `connectionIds` | This workspace's active connections that can use it |
| `reason` | Why it is unavailable, when it is |

Discovery reports what a workspace can do **on this gateway**. It does not select providers: there is nothing to select, because the gateway has one.

### Health

`{ status: "ok" | "degraded" | "unavailable", checks: { <name>: { ok, detail? } }, checkedAt }`. Health must **not** generate upstream provider traffic.

## 2. Workspace and request context

- **Workspace**: `WorkspaceIdentity { workspaceId }`, which is Zeptly's identifier and nothing more. The gateway maps it to an internal row and an opaque per-workspace tenant ref that it sends upstream. The Zeptly id is never sent to the provider.
- **Request context** (`GatewayRequestContext`) carries:
  - the authenticated `caller` service;
  - the optional `workspace`;
  - the optional `agent` (audit only);
  - `correlationId` (`X-Request-Id`, echoed);
  - the optional `idempotencyKey`.
- **Authentication**: ZS1-HMAC-SHA256 signed service requests (see [SECURITY.md](SECURITY.md)). Workspace-scoped operations require the signed `X-Zeptly-Workspace-Id` header.
- **Idempotency**: `Idempotency-Key`, 8–128 characters of `[A-Za-z0-9._:-]`. It is required on every non-naturally-idempotent command. A replay returns the original response. Reusing a key with a different request is `IDEMPOTENCY_CONFLICT`, and a missing key is `IDEMPOTENCY_KEY_REQUIRED`. Keys are scoped per workspace and operation.

## 3. Provider references and ownership

```ts
interface ProviderReference { provider: string; kind: string; externalId: string }
```

Provider references live only in a gateway's integration records. They are **never** part of a canonical object and **never** establish ownership. Ownership always runs:

```
workspace → gateway connection → provider account (UNIQUE(provider, externalId))
```

An inbound provider id (webhook, reconciliation) is resolved through the stored mapping. An unknown id is ignored and never adopted into a workspace. Architecture tests and cross-tenant integration tests enforce this.

## 4. Connections and provisioning

A **gateway connection** is a workspace's link to one provider account on one channel:

`GatewayConnection` has these fields:

- `id`, `workspaceId`, `channel`, `status`
- `statusReason?`, `displayName?`, `username?`, `avatarUrl?`, `accountType?`
- `provider` (diagnostic only)
- `connectedAt?`, `lastCheckedAt?`, `createdAt`, `updatedAt`

Status is `pending | connected | degraded | reauthorization_required | disconnected`.

A capability contract may extend the connection with its own view. Social Publishing's `SocialConnection` adds `network` (equal to `channel`) and per-network feature flags.

**Provisioning** is a state-token-bound session:

- `strategy` is `oauth_redirect | provider_managed | credentials`.
- `status` is `initiated | awaiting_selection | completed | failed | expired`.
- An `authorizationUrl` is present while initiated.
- `options` are present while awaiting selection.

Endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/connections/channels` | Channels and their strategies |
| `POST /v1/connections {channel, returnUrl?, credentials?}` | Start provisioning |
| `GET /v1/provisioning/{id}` | Read a provisioning session |
| `POST /v1/provisioning/{id}/finalize {optionIds}` | Finish provisioning with the selected options |
| `GET /v1/connect/callback/{state}` | Public browser return |
| `GET/DELETE /v1/connections/{id}` | Read or disconnect a connection |
| `POST /v1/connections/{id}/reconnect` | Start reauthorization |
| `POST /v1/connections/reconcile` | Reconcile the workspace's connections with the provider |

Credentials are forwarded once and never stored or logged.

## 5. Canonical errors

Every error response is:

```json
{ "error": { "code": "CONNECTION_NOT_FOUND", "message": "…", "details": {}, "retryable": false, "requestId": "…" } }
```

Codes form an **extensible registry** (`ErrorCodeRegistry` + `defineErrorCodes`). The contract defines the gateway codes, and capability contracts register their own. Clients must treat unknown codes by HTTP status.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `AUTHENTICATION_FAILED` | 401 | Bad or missing service signature |
| `WORKSPACE_FORBIDDEN` | 403 | Missing workspace on a workspace route |
| `NOT_FOUND` | 404 | Generic not found |
| `CONNECTION_NOT_FOUND` | 404 | Unknown connection, or one owned by another workspace (indistinguishable) |
| `PROVISIONING_NOT_FOUND` / `PROVISIONING_EXPIRED` | 404 / 410 | Provisioning session |
| `CONNECTION_OWNERSHIP_CONFLICT` | 409 | Provider account already mapped to another workspace |
| `CONNECTION_NOT_ACTIVE` / `REAUTHORIZATION_REQUIRED` | 409 | Connection unusable |
| `CAPABILITY_NOT_SUPPORTED` / `NETWORK_NOT_SUPPORTED` | 422 | Not offered by this gateway (for this channel) |
| `PROVIDER_UNAVAILABLE` / `PROVIDER_RATE_LIMITED` / `PROVIDER_REJECTED` | 503 / 429 / 422 | Upstream failure; the sanitized provider message is only in `details.provider` |
| `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_KEY_REQUIRED` | 409 / 400 | Idempotency |
| `INVALID_STATE` | 409 | Operation not allowed in the current state |
| `VALIDATION_ERROR` | 400 | Schema or semantic validation |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | Webhook authentication |
| `RATE_LIMITED` | 429 | Gateway-side rate limit |
| `INTERNAL_ERROR` | 500 | Unexpected |

The exact HTTP statuses are in `packages/gateway-contract/src/errors.ts`, which is authoritative. Provider failures reach the gateway as `UpstreamError` (kind: `rate_limit | auth | validation | not_found | conflict | server | network | timeout | protocol | unsupported`, plus `retryable`/`ambiguous`/`retryAfterSeconds`). Gateway-core translates them to the codes above, and callers never parse provider strings.

## 6. Envelopes

**Webhook envelope.** Each provider webhook is authenticated over the raw bytes, deduplicated by a deterministic `eventId`, and interpreted into:

```ts
interface WebhookEnvelope<E extends { kind: string }> { provider; eventType; eventId; occurredAt; event: E }
```

`event.kind` is provider-neutral:

- Gateway-owned kinds are `account.reauthorization_required`, `gateway.test` and `gateway.ignored`.
- Capabilities claim their own kinds, for example `social.publication_outcome` and `social.direct_message`.
- An envelope no handler claims is stored and marked `ignored`.

The receiver responds `WebhookReceipt { accepted, duplicate }`.

**Audit envelope.** `AuditEnvelope` has these fields:

- `gateway`, `workspaceId | null`
- `action` (dotted, for example `connection.established`)
- `actor { service, agent? }`
- `resource? { type, id }`
- `correlationId`, `metadata`, `occurredAt`

Secrets are redacted before persistence.

## 7. Versioning and compatibility

- The contract version changes only on a breaking change. Additive fields are allowed within a version.
- Each capability contract is versioned independently (`id@version`). A gateway may offer several versions of one capability by registering several modules.
- Deprecated HTTP aliases carry `Deprecation: true` and `Link: <successor>; rel="successor-version"`, and are marked `deprecated` in OpenAPI.

## 8. Capability contracts built on v1 (this gateway)

| Capability | Contract | HTTP surface |
| --- | --- | --- |
| `social.publishing@1` | `@zeptly-gateway/social-publishing/contract` | `/v1/social/publishing/{networks,media,posts}` |
| `social.scheduling@1` | same package (schedules and rolling hand-off) | `/v1/social/publishing/posts/{id}/schedule` |
| `social.analytics.basic@1` | `@zeptly-gateway/social-analytics/contract` | `/v1/social/analytics/{metrics,posts/{id}/refresh}` |
| `social.direct_messages@1` | `@zeptly-gateway/social-direct-messages/contract` | `/v1/social/direct-messages/conversations…` |
