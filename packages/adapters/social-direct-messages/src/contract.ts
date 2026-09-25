/**
 * Social Direct Messages Contract v1 (capability id "social.direct_messages").
 * Deliberately narrow: one-to-one direct-message conversations on connected
 * social accounts where the provider supports them. This is NOT a universal
 * inbox — no cross-channel threads, SMS, email or broadcasts.
 */
import { defineErrorCodes } from "@zeptly-gateway/gateway-contract";
import { SocialNetworkSchema } from "@zeptly-gateway/social-publishing/contract";
import { z } from "zod";

declare module "@zeptly-gateway/gateway-contract" {
  interface ErrorCodeRegistry {
    CONVERSATION_NOT_FOUND: true;
  }
}

defineErrorCodes({ CONVERSATION_NOT_FOUND: { status: 404 } });

export const SOCIAL_DIRECT_MESSAGES_CONTRACT = { id: "social.direct_messages", version: "1" } as const;

const IsoDateTime = z.iso.datetime({ offset: true });
const Id = z.uuid();

export const SocialParticipantSchema = z
  .object({
    displayName: z.string().optional(),
    username: z.string().optional(),
    avatarUrl: z.string().optional(),
  })
  .meta({ id: "SocialParticipant" });

export const SocialConversationSchema = z
  .object({
    id: Id,
    workspaceId: z.string(),
    connectionId: Id,
    network: SocialNetworkSchema,
    kind: z.enum(["direct_message"]),
    participant: SocialParticipantSchema,
    lastMessageAt: IsoDateTime.optional(),
    lastMessagePreview: z.string().optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "SocialConversation" });
export type SocialConversation = z.infer<typeof SocialConversationSchema>;

export const SocialMessageSchema = z
  .object({
    id: Id,
    conversationId: Id,
    direction: z.enum(["inbound", "outbound"]),
    status: z.enum(["received", "sending", "sent", "failed"]),
    text: z.string().optional(),
    attachments: z.array(z.object({ type: z.string(), url: z.string().optional() })),
    sentAt: IsoDateTime.optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    createdAt: IsoDateTime,
  })
  .meta({ id: "SocialMessage" });
export type SocialMessage = z.infer<typeof SocialMessageSchema>;

export const SendMessageRequestSchema = z
  .object({ text: z.string().min(1).max(1000) })
  .meta({ id: "SendMessageRequest" });
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
