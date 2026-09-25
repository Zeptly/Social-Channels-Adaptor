import type { SocialConversationRow, SocialMessageRow, Workspace } from "@zeptly-gateway/database";
import { opt } from "@zeptly-gateway/gateway-core";
import type { SocialNetwork } from "@zeptly-gateway/social-publishing/contract";
import type { SocialConversation, SocialMessage } from "../contract.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

export function toConversation(row: SocialConversationRow, ws: Workspace): SocialConversation {
  const p = row.participant;
  return {
    id: row.id,
    workspaceId: ws.externalId,
    connectionId: row.connectionId,
    network: row.network as SocialNetwork,
    kind: "direct_message",
    participant: { ...opt("displayName", p.displayName), ...opt("username", p.username), ...opt("avatarUrl", p.avatarUrl) },
    ...opt("lastMessageAt", iso(row.lastMessageAt)),
    ...opt("lastMessagePreview", row.lastMessagePreview),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMessage(row: SocialMessageRow): SocialMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction as SocialMessage["direction"],
    status: row.status as SocialMessage["status"],
    ...opt("text", row.text),
    attachments: row.attachments,
    ...opt("sentAt", iso(row.sentAt)),
    ...(row.errorCode ? { error: { code: row.errorCode, message: row.errorMessage ?? "" } } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}
