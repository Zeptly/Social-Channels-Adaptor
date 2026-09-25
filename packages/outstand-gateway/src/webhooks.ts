import type { WebhookEnvelope } from "@zeptly-gateway/gateway-contract";
import { GATEWAY_EVENT_KINDS, type WebhookSource } from "@zeptly-gateway/gateway-core";
import { OUTSTAND, type OutstandWebhookEvent, OutstandWebhookVerifier, SIGNATURE_HEADER } from "@zeptly-gateway/outstand-client";
import { DIRECT_MESSAGE_EVENT } from "@zeptly-gateway/social-direct-messages";
import { toRemoteConversation, toRemoteMessage } from "@zeptly-gateway/social-direct-messages/outstand";
import { PUBLICATION_OUTCOME_EVENT } from "@zeptly-gateway/social-publishing";

/**
 * Outstand webhooks → gateway webhook envelopes. Signature verification and
 * payload parsing stay in the Outstand client; this maps Outstand's typed
 * facts onto the event kinds claimed by gateway infrastructure and capabilities.
 */
export function outstandWebhookSource(secret: string): WebhookSource {
  const verifier = new OutstandWebhookVerifier(secret);
  return {
    provider: OUTSTAND,
    signatureHeader: SIGNATURE_HEADER,
    verify: (rawBody, signature) => verifier.verify(rawBody, signature),
    parse(rawBody): WebhookEnvelope {
      const parsed = verifier.parse(rawBody);
      return { provider: OUTSTAND, eventType: parsed.type, eventId: parsed.eventId, occurredAt: parsed.event.occurredAt, event: toGatewayEvent(parsed.event) };
    },
  };
}

function toGatewayEvent(e: OutstandWebhookEvent): { kind: string } & Record<string, unknown> {
  switch (e.kind) {
    case "post_outcome":
      return { kind: PUBLICATION_OUTCOME_EVENT, providerPostId: e.providerPostId, accounts: e.accounts.map((a) => ({ ...a })) };
    case "account_token_expired":
      return { kind: GATEWAY_EVENT_KINDS.accountReauthorizationRequired, accountExternalId: e.accountExternalId, ...(e.reason ? { reason: e.reason } : {}) };
    case "conversation_message":
      return {
        kind: DIRECT_MESSAGE_EVENT,
        accountExternalId: e.accountExternalId,
        conversation: toRemoteConversation(e.conversation),
        ...(e.message ? { message: toRemoteMessage(e.message) } : {}),
      };
    case "test":
      return { kind: GATEWAY_EVENT_KINDS.test };
    case "ignored":
      return { kind: GATEWAY_EVENT_KINDS.ignored };
  }
}
