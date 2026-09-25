/**
 * @zeptly-gateway/outstand-client — Outstand transport, authentication, wire
 * mapping, errors, rate-limit handling and webhook interpretation.
 *
 * Public surface: the client, its typed/sanitized results, the error class and
 * webhook verification. Wire schemas (wire.ts) are deliberately NOT exported.
 */
export { OutstandClient, DEFAULT_OUTSTAND_BASE_URL, type OutstandClientOptions } from "./client.js";
export { OutstandError, OUTSTAND } from "./errors.js";
export { SIGNATURE_HEADER, computeSignature, verifySignature, parseWebhook, OutstandWebhookVerifier } from "./webhooks.js";
export type * from "./types.js";
