import type { OutstandClient, OutstandConversation, OutstandMessage } from "@zeptly-gateway/outstand-client";
import type { RemoteConversation, RemoteMessage, RemotePage, SocialDirectMessagesPort } from "../port.js";

/** Outstand implementation of the Social Direct Messages port. */
export class OutstandSocialDirectMessagesAdapter implements SocialDirectMessagesPort {
  readonly provider: string;

  constructor(private readonly client: OutstandClient) {
    this.provider = client.provider;
  }

  async listConversations(input: { accountExternalId: string; cursor?: string }): Promise<RemotePage<RemoteConversation>> {
    const page = await this.client.listConversations(input);
    return { items: page.items.map(toRemoteConversation), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async listMessages(input: { conversationExternalId: string; cursor?: string }): Promise<RemotePage<RemoteMessage>> {
    const page = await this.client.listMessages(input);
    return { items: page.items.map(toRemoteMessage), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async sendMessage(input: { conversationExternalId: string; text: string; idempotencyKey: string }): Promise<RemoteMessage> {
    return toRemoteMessage(await this.client.sendMessage(input));
  }
}

export const toRemoteConversation = (c: OutstandConversation): RemoteConversation => ({
  externalId: c.externalId,
  accountExternalId: c.accountExternalId,
  participant: { ...c.participant },
  ...(c.lastMessageAt ? { lastMessageAt: c.lastMessageAt } : {}),
  ...(c.lastMessagePreview ? { lastMessagePreview: c.lastMessagePreview } : {}),
});

export const toRemoteMessage = (m: OutstandMessage): RemoteMessage => ({
  externalId: m.externalId,
  conversationExternalId: m.conversationExternalId,
  direction: m.direction,
  status: m.status,
  ...(m.text !== undefined ? { text: m.text } : {}),
  attachments: m.attachments.map((a) => ({ ...a })),
  ...(m.sentAt ? { sentAt: m.sentAt } : {}),
  ...(m.error ? { error: m.error } : {}),
});
