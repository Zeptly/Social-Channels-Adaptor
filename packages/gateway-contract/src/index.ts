/**
 * Zeptly Gateway Contract v1 — provider-gateway-level concerns only
 * (identity, workspace context, capabilities, errors, health, audit, webhooks,
 * connections). Capability domains (social posts, conversations, metrics, …)
 * live in their own typed capability contracts. See docs/GATEWAY-CONTRACT.md.
 */
export * from "./gateway.js";
export * from "./errors.js";
export * from "./envelopes.js";
export * from "./connections.js";
