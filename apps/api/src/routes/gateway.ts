import { CapabilityAvailabilitySchema, GatewayDescriptorSchema, GatewayHealthSchema } from "@zeptly-gateway/gateway-contract";
import type { OutstandGatewayRuntime } from "@zeptly-gateway/outstand-gateway";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, errorResponses } from "../app.js";
import { security, serviceHeaders, workspaceHeaders, zapp } from "./common.js";

const CapabilityList = z.object({ data: z.array(CapabilityAvailabilitySchema) }).meta({ id: "CapabilityAvailabilityList" });

/** Gateway Contract v1: identity, health and per-workspace capability discovery. */
export function registerGatewayRoutes(app: FastifyInstance, rt: OutstandGatewayRuntime): void {
  const r = zapp(app);

  r.get(
    "/v1/gateway",
    {
      config: { auth: "service" },
      schema: {
        tags: ["gateway"],
        summary: "Describe this gateway (identity, contract version, capabilities, channels)",
        security,
        headers: serviceHeaders,
        response: { 200: GatewayDescriptorSchema, ...errorResponses },
      },
    },
    async () => rt.gateway.describe(),
  );

  r.get(
    "/v1/gateway/health",
    {
      config: { auth: "service" },
      schema: {
        tags: ["gateway"],
        summary: "Gateway health (local checks only; never calls the provider)",
        security,
        headers: serviceHeaders,
        response: { ...errorResponses, 200: GatewayHealthSchema, 503: GatewayHealthSchema },
      },
    },
    async (_req, reply) => {
      const health = await rt.gateway.health();
      return reply.status(health.status === "unavailable" ? 503 : 200).send(health);
    },
  );

  r.get(
    "/v1/capabilities",
    {
      schema: {
        tags: ["gateway"],
        summary: "Capabilities this gateway offers and whether the workspace can use them now",
        description:
          "A capability is available when it is enabled on this gateway and the workspace has at least one active (connected or degraded) connection on a channel that supports it. There is no provider selection: every capability is backed by this gateway's provider.",
        security,
        headers: workspaceHeaders,
        response: { 200: CapabilityList, ...errorResponses },
      },
    },
    async (req) => ({ data: await rt.registry.availability(rt.ctx, actorOf(req).workspace) }),
  );
}
