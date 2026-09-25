# Outstand wire fixtures — 2026-09

Versioned representations of Outstand responses/webhooks the adapter is
contract-tested against. Sources (see docs/OUTSTAND.md → Evidence):

- `@outstand-so/ui` v0.1.13 TypeScript declarations (accounts, pending, media, posts, analytics).
- Live-observed shapes recorded by the Outstand-UI reference implementation and
  `pigfox/outstand-go` (create-post `{ success, post }` envelope, `network_data`
  tokens inside `socialAccounts[]`, `accounts` request key).
- Outstand webhook documentation as verified 2026-09-23 (envelope `{event, timestamp, data}`).
- `conversation-*.json` are **provisional**: Outstand's conversation payloads
  could not be fetched from the build environment; confirm with the live suite.

When Outstand changes a shape: add a new dated folder, keep the old one, and
make the adapter accept both until the old shape is retired.
