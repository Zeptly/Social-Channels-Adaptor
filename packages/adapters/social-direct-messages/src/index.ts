/**
 * Social Direct Messages capability (contract "social.direct_messages" v1).
 * Narrow by design — not a universal inbox. The Outstand implementation of the
 * port lives under the "./outstand" subpath.
 */
export * from "./contract.js";
export * from "./port.js";
export type { SocialDirectMessagesContext } from "./service/context.js";
export * as conversations from "./service/conversations.js";
export { toConversation, toMessage } from "./service/serializers.js";
export { directMessageHandler, socialDirectMessagesModule } from "./service/module.js";
