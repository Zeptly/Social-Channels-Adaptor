# Provider model

## Contract

`packages/provider-contract` defines `SocialProvider`:

| Group | Methods |
| --- | --- |
| Identity | `name`, `schedulingHorizonMs`, `webhooks` (`verify`, `parse` → provider-neutral `ProviderEvent`) |
| Provisioning | `initiateConnection`, `connectWithCredentials?`, `getPendingConnection`, `finalizeConnection`, `listAccounts`, `disconnectAccount`, `checkCredentials` |
| Media | `prepareUpload`, `confirmUpload`, `uploadFromUrl` |
| Posts | `publish`, `schedule`, `getPost`, `deletePost` |
| Optional | `getMetrics?`, `listConversations?`, `listMessages?`, `sendMessage?` |

Adapters raise `ProviderError`, which carries `kind`, `retryable`, `ambiguous`, `retryAfterSeconds` and sanitized details. `packages/core/src/provider-errors.ts` translates these into canonical error codes. External ids are opaque strings, and core stores them only in integration columns.

## Capability registry and router

`packages/capability-registry` holds one version-controlled `ProviderCapabilityTable` per provider. The V1 table is Outstand, `2026.09.23-1`. `CapabilityRouter.resolve({capability, network, workspaceId})` picks the first provider, in table order or a per-workspace override order, that supports the capability for the network. Operations on an existing resource use the provider recorded on it, `social_connections.provider`.

A flag in the registry means "this service exposes it", backed by verified evidence. It does not mean "the upstream API has an endpoint".

## Adding a provider (Zernio, Unipile, …)

1. Implement `SocialProvider` in `packages/provider-<name>`, following the structure of `provider-outstand`.
2. Add a `ProviderCapabilityTable` for its verified networks and capabilities.
3. Register both in `packages/core/src/factory.ts`, and add its name to `PROVIDER_NAMES`.
4. Add its webhook route (`/v1/webhooks/<name>`), which reuses `webhooks.receiveWebhook`.
5. Add contract fixtures and tests.

None of these steps changes the public API or the canonical objects. The router tests include a hypothetical second provider that serves conversations and analytics for different networks.

## Future providers (documented, not implemented)

### Zernio
Possible responsibilities: networks beyond the Outstand Managed-Key set, richer analytics (a second `analytics` provider per workspace or network), advertising, and additional inbox capabilities such as comments or DMs on more networks. Conversations and metrics are already provider-neutral (`SocialConversation`, `SocialMetric.semantics = <network>.<metric>`), so Zeptly's Inbox and analytics can aggregate them without redesign.

### Unipile
Possible responsibilities: workflow and batch-oriented operations, outreach-oriented operations, and other authenticated social workflows. These would become new capabilities in the registry, exposed through new canonical endpoints only when Zeptly requires them.

Neither provider is implemented in V1, and no speculative code exists for them.
