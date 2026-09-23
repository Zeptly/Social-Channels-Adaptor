import { z } from "zod";
import { ConnectionStrategySchema, SocialNetworkSchema } from "./networks.js";

/**
 * Operations that are routed by capability. Each maps to a boolean flag in
 * {@link SocialCapabilities}.
 */
export const CAPABILITIES = [
  "connect",
  "publish",
  "schedule",
  "media",
  "analytics",
  "comments",
  "conversations",
  "directMessages",
  "delete",
  "firstComment",
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const SocialCapabilitiesSchema = z
  .object({
    connect: z.boolean(),
    publish: z.boolean(),
    schedule: z.boolean(),
    media: z.boolean(),
    analytics: z.boolean(),
    comments: z.boolean(),
    conversations: z.boolean(),
    directMessages: z.boolean(),
    delete: z.boolean(),
    firstComment: z.boolean(),
  })
  .meta({
    id: "SocialCapabilities",
    description:
      "Capabilities this service exposes for a network. A false flag means the operation is rejected with CAPABILITY_NOT_SUPPORTED.",
  });
export type SocialCapabilities = z.infer<typeof SocialCapabilitiesSchema>;

export const MediaKindSchema = z.enum(["image", "video"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaKindConstraintSchema = z
  .object({
    maxItems: z.number().int().nonnegative(),
    mimeTypes: z.array(z.string()),
    maxSizeBytes: z.number().int().positive().optional(),
  })
  .meta({ id: "MediaKindConstraint" });
export type MediaKindConstraint = z.infer<typeof MediaKindConstraintSchema>;

export const NetworkOptionSpecSchema = z
  .object({
    key: z.string(),
    type: z.enum(["string", "boolean", "enum", "string_array"]),
    required: z.boolean(),
    values: z.array(z.string()).optional(),
    maxLength: z.number().int().positive().optional(),
    description: z.string().optional(),
  })
  .meta({ id: "NetworkOptionSpec" });
export type NetworkOptionSpec = z.infer<typeof NetworkOptionSpecSchema>;

export const NetworkConstraintsSchema = z
  .object({
    maxTextLength: z.number().int().positive(),
    textRequired: z.boolean(),
    mediaRequired: z.boolean(),
    maxMediaItems: z.number().int().nonnegative(),
    allowMixedMedia: z.boolean(),
    image: MediaKindConstraintSchema.optional().describe("Absent when images are not supported"),
    video: MediaKindConstraintSchema.optional().describe("Absent when video is not supported"),
    options: z.array(NetworkOptionSpecSchema).describe("Verified network-specific option keys accepted in target.options"),
  })
  .meta({ id: "NetworkConstraints" });
export type NetworkConstraints = z.infer<typeof NetworkConstraintsSchema>;

export const NetworkDescriptorSchema = z
  .object({
    network: SocialNetworkSchema,
    displayName: z.string(),
    connectionStrategy: ConnectionStrategySchema.describe("Default strategy used when POST /v1/connections carries no credentials"),
    supportedStrategies: z.array(ConnectionStrategySchema),
    capabilities: SocialCapabilitiesSchema,
    constraints: NetworkConstraintsSchema,
    notes: z.array(z.string()),
  })
  .meta({ id: "NetworkDescriptor" });
export type NetworkDescriptor = z.infer<typeof NetworkDescriptorSchema>;
