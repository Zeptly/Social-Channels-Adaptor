/** What a gateway's provider adapter provides for Social Direct Messages. */
export interface RemoteParticipant {
  externalId?: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
}

export interface RemoteMessage {
  externalId: string;
  conversationExternalId: string;
  direction: "inbound" | "outbound";
  status: "received" | "sent" | "failed" | "sending";
  text?: string;
  attachments: Array<{ type: string; url?: string }>;
  sentAt?: Date;
  error?: string;
}

export interface RemoteConversation {
  externalId: string;
  accountExternalId: string;
  participant: RemoteParticipant;
  lastMessageAt?: Date;
  lastMessagePreview?: string;
}

export interface RemotePage<T> {
  items: T[];
  nextCursor?: string;
}

export interface SocialDirectMessagesPort {
  readonly provider: string;
  listConversations(input: { accountExternalId: string; cursor?: string }): Promise<RemotePage<RemoteConversation>>;
  listMessages(input: { conversationExternalId: string; cursor?: string }): Promise<RemotePage<RemoteMessage>>;
  sendMessage(input: { conversationExternalId: string; text: string; idempotencyKey: string }): Promise<RemoteMessage>;
}

/** Normalized webhook event claimed by the Direct Messages capability. */
export const DIRECT_MESSAGE_EVENT = "social.direct_message" as const;

export interface DirectMessageEvent {
  kind: typeof DIRECT_MESSAGE_EVENT;
  accountExternalId: string;
  conversation: RemoteConversation;
  message?: RemoteMessage;
}
