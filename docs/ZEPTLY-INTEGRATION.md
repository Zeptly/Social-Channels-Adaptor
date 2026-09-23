# Zeptly integration

This describes exactly how the main Zeptly application consumes Zeptly Social. Zeptly never talks to Outstand and never holds an Outstand key or identifier.

## 1. Configuration in Zeptly (server-side only)

| Setting | Value |
| --- | --- |
| `ZEPTLY_SOCIAL_BASE_URL` | `https://<zeptly-social API domain>` |
| `ZEPTLY_SOCIAL_SERVICE_SECRET` | Same value as `ZEPTLY_SERVICE_SECRET` on Zeptly Social |
| Caller id | e.g. `zeptly-app` (per calling service; lower-case, `[a-z0-9._-]`) |

All calls must come from Zeptly's backend: the secret must never reach a browser. The only browser interaction is redirecting the user to `authorizationUrl` and receiving them back on `returnUrl`.

## 2. Typed client

Generate a client from the committed contract:

```bash
# in the Zeptly repo
npx openapi-typescript https://<api-domain>/openapi.json -o src/lib/zeptly-social/schema.d.ts
# or from a pinned copy of openapi/openapi.json in this repo
```

Wrap it with a `fetch` that signs every request:

```ts
import { createHash, createHmac, randomUUID } from "node:crypto";

export async function zeptlySocial(method: string, path: string, opts: { workspaceId?: string; body?: unknown; agent?: string; idempotencyKey?: string } = {}) {
  const raw = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
  const ts = String(Math.floor(Date.now() / 1000));
  const caller = "zeptly-app";
  const canonical = ["ZS1", ts, method, path, opts.workspaceId ?? "", caller, opts.agent ?? "", createHash("sha256").update(raw ?? Buffer.alloc(0)).digest("hex")].join("\n");
  const res = await fetch(`${process.env.ZEPTLY_SOCIAL_BASE_URL}${path}`, {
    method,
    headers: {
      "x-zeptly-caller": caller,
      "x-zeptly-timestamp": ts,
      "x-zeptly-signature": `v1=${createHmac("sha256", process.env.ZEPTLY_SOCIAL_SERVICE_SECRET!).update(canonical).digest("hex")}`,
      ...(opts.workspaceId ? { "x-zeptly-workspace-id": opts.workspaceId } : {}),
      ...(opts.agent ? { "x-zeptly-agent": opts.agent } : {}),
      ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      ...(raw ? { "content-type": "application/json" } : {}),
      "x-request-id": randomUUID(),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}
```

`path` must be signed exactly as sent, including the query string. `scripts/zs.ts` is a reference implementation of the same signing.

## 3. Workspaces

Send the Zeptly workspace id in `X-Zeptly-Workspace-Id` (`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`). Zeptly Social registers it lazily and never needs other workspace data. Zeptly remains responsible for deciding whether the acting user may use social features. Put the acting agent or user reference in `X-Zeptly-Agent` so it appears in the audit trail.

## 4. Connecting accounts

1. `GET /v1/networks` renders the connect options: `capabilities`, `connectionStrategy`, `supportedStrategies` and `constraints`.
2. `POST /v1/connections {network, returnUrl}` returns `provisioning.authorizationUrl`. Redirect the user's browser there. `returnUrl` must use an origin in `ALLOWED_RETURN_URL_ORIGINS`.
3. The user returns to `returnUrl?provisioningId=<id>&status=<status>`:
   - `completed`: `GET /v1/provisioning/{id}`, then `connectionIds` → `GET /v1/connections/{id}`.
   - `awaiting_selection`: show `provisioning.options` (pages/organisations), then `POST /v1/provisioning/{id}/finalize {optionIds}`.
   - `failed` / `expired`: show `provisioning.error` and offer to retry.
4. Bluesky can also connect without a redirect: `POST /v1/connections {network:"bluesky", credentials:{handle, appPassword}}` returns the connection directly. Never store the app password in Zeptly either.
5. When a connection reaches `reauthorization_required` (Zeptly sees this on `GET /v1/connections`), show a reconnect CTA → `POST /v1/connections/{id}/reconnect {returnUrl}`, and continue from step 2.

## 5. Publishing and scheduling

Zeptly generates all content, including per-network variants. This service never rewrites it.

```
POST /v1/posts            Idempotency-Key: <stable key per Zeptly content item/version>
{ "content": { "text": "Base copy", "mediaIds": ["<media id>"] },
  "targets": [
    { "connectionId": "<linkedin conn>" },
    { "connectionId": "<instagram conn>", "content": { "text": "IG variant #tags" }, "options": { "mediaType": "FEED" } },
    { "connectionId": "<youtube conn>", "options": { "title": "Launch", "privacyStatus": "unlisted" } }
  ],
  "externalRef": "zeptly-content-123" }
```

- Then call `POST /v1/posts/{id}/publish` or `POST /v1/posts/{id}/schedule {scheduledAt, timezone}`, each with an Idempotency-Key.
- The schedule can be any distance ahead (up to 2 years). Zeptly Social hands it to the provider inside the provider's window. Rescheduling is another `schedule` call; `cancel` stops unpublished targets.
- Track outcomes by polling `GET /v1/posts/{id}`, or list with `GET /v1/posts?status=`. Use per-target `status` and `error.code`:
  - `TARGET_DROPPED_BY_PROVIDER` and `PUBLICATION_FAILED`: show them to the user.
  - `REAUTHORIZATION_REQUIRED`: prompt a reconnect.
  - `PUBLICATION_STATE_UNKNOWN`: needs manual review.
- `partially_published` is a first-class outcome and must be shown as such.
- Media: `POST /v1/media` with a durable HTTPS URL (preferred), then wait for `status=ready` before `publish`/`schedule`. Direct uploads use `source.type=upload` → PUT to `uploadUrl` → `POST /v1/media/{id}/complete`.

Recommended Idempotency-Key strategy: derive keys deterministically from Zeptly ids, e.g. `content:<id>:v<version>` for create and `publish:<postId>:<attempt>` for commands. A retried Zeptly job then reuses the key automatically.

## 6. Metrics

`GET /v1/metrics?postId=` or `?connectionId=`, or `POST /v1/posts/{id}/metrics/refresh` for fresh data. Only metrics the provider reports are returned. Treat `semantics` (`<network>.<metric>`) as the identity of a metric, and do not sum or compare different semantics across networks unless Zeptly deliberately defines such an aggregate.

## 7. Conversations (Inbox)

Check `connection.capabilities.conversations` before showing a connection in the Inbox. In V1 only Instagram is `true`. `GET /v1/conversations`, `GET /v1/conversations/{id}/messages` (with `refresh=true` to pull the latest) and `POST /v1/conversations/{id}/messages {text}` with an Idempotency-Key. Unsupported networks return `422 CAPABILITY_NOT_SUPPORTED`. The objects are provider-neutral, so later providers will appear in the same lists.

## 8. Error handling

Branch on `error.code` and `error.retryable` only. Retry `retryable` errors with backoff, and always resend the same Idempotency-Key.
