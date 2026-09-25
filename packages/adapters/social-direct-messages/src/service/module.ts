import { type CapabilityModule, findAccountByExternalId, type WebhookEventHandler } from "@zeptly-gateway/gateway-core";
import { SOCIAL_DIRECT_MESSAGES_CONTRACT } from "../contract.js";
import { DIRECT_MESSAGE_EVENT, type DirectMessageEvent } from "../port.js";
import type { SocialDirectMessagesContext } from "./context.js";
import { syncConversations, upsertConversationFromProvider } from "./conversations.js";

/** Inbound direct-message webhooks: resolved to a workspace only through stored account mappings. */
export const directMessageHandler: WebhookEventHandler<SocialDirectMessagesContext> = {
  kinds: [DIRECT_MESSAGE_EVENT],
  async handle(ctx, envelope) {
    const event = envelope.event as DirectMessageEvent;
    const mapping = await findAccountByExternalId(ctx.db, envelope.provider, event.accountExternalId);
    if (!mapping) return { status: "ignored" };
    if (!ctx.socialCatalog.supports(mapping.connection.network, "conversations")) return { status: "ignored" };
    await upsertConversationFromProvider(ctx, mapping, event.conversation, event.message ? [event.message] : []);
    return { status: "processed", workspaceId: mapping.connection.workspaceId };
  },
};

/** Social Direct Messages: provider DM conversations on connected accounts (Instagram only on Outstand). */
export function socialDirectMessagesModule(channels: () => string[]): CapabilityModule<SocialDirectMessagesContext> {
  return {
    descriptor: { ...SOCIAL_DIRECT_MESSAGES_CONTRACT, title: "Social direct messages", description: "Read and reply to direct-message conversations on supported social accounts." },
    channels,
    jobs: { sync_conversations: (ctx) => syncConversations(ctx) },
    periodic: [{ type: "sync_conversations", everyMs: 10 * 60_000 }],
    webhookHandlers: [directMessageHandler],
  };
}
