# Providers and gateways

This repository is **one provider gateway**, the Outstand Gateway. It is not a multi-provider router.

| Before the gateway refactor | Now |
| --- | --- |
| `SocialProvider` interface + `ProviderRegistry` + `CapabilityRouter` resolving `(capability, network, workspace) → provider`, with per-workspace provider overrides | One provider per gateway. Capability packages define provider-neutral **ports**, and the gateway implements them once, on the Outstand client. Discovery reports what *this* gateway offers a workspace (`GET /v1/capabilities`) |

## How provider code is organised

- `packages/outstand-client` is the only code that speaks Outstand. It handles transport, auth, private wire schemas, typed sanitized results, `OutstandError` (an `UpstreamError` from the Gateway Contract), rate limits and webhook verification.
- `packages/adapters/<capability>/src/outstand` contains typed capability adapters: `OutstandSocialPublishingAdapter`, `OutstandSocialAnalyticsAdapter` and `OutstandSocialDirectMessagesAdapter`. Each implements its capability's port by translating Outstand's typed results into port types.
- `packages/outstand-gateway` contains the account port (`OutstandAccountPort` implements gateway-core's `ProviderAccountPort`), the Outstand `WebhookSource` and the composition root.

External ids are opaque strings. They are stored only in integration columns and never establish ownership.

## Adding another provider

Build **another gateway**, for example a Zernio Gateway, as its own deployable service that implements [Gateway Contract v1](GATEWAY-CONTRACT.md). It reuses `gateway-contract`, `gateway-core` and whichever capability contracts and services apply, and supplies its own `<provider>-client` and adapters.

Zeptly discovers each gateway with `GET /v1/gateway` and `GET /v1/capabilities`, and decides which gateway serves which workspace or capability. Nothing in this repository selects between providers.

The concrete recommendations are in [REFACTOR-REPORT.md](REFACTOR-REPORT.md#recommendations-for-a-future-zernio-gateway). No code for other providers exists here.
