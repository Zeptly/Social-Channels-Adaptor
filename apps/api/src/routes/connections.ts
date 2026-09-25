import {
  ConnectionStatusSchema,
  FinalizeProvisioningRequestSchema,
  GatewayConnectionSchema,
  GatewayError,
  ProvisioningSessionSchema,
} from "@zeptly-gateway/gateway-contract";
import { type ConnectionResult, connections } from "@zeptly-gateway/gateway-core";
import type { OutstandGatewayRuntime } from "@zeptly-gateway/outstand-gateway";
import { SocialConnectionSchema, SocialNetworkSchema } from "@zeptly-gateway/social-publishing/contract";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, errorResponses } from "../app.js";
import { IdParams, security, workspaceHeaders, zapp } from "./common.js";

const Strategy = z.enum(["oauth_redirect", "provider_managed", "credentials"]);

const ChannelSchema = z
  .object({
    channel: z.string(),
    displayName: z.string(),
    connectionStrategy: Strategy,
    supportedStrategies: z.array(Strategy),
    notes: z.array(z.string()),
  })
  .meta({ id: "GatewayChannel" });
const ChannelList = z.object({ data: z.array(ChannelSchema) }).meta({ id: "GatewayChannelList" });

const Credentials = z
  .object({ handle: z.string().min(3).max(253), appPassword: z.string().min(8).max(128) })
  .describe("Bluesky handle + app password (credentials strategy). Forwarded once to the provider, never stored or logged.");

export const CreateConnectionRequestSchema = z
  .object({
    channel: SocialNetworkSchema.optional().describe("Channel to connect (for this gateway: a social network)"),
    network: SocialNetworkSchema.optional().describe("Deprecated alias of `channel`"),
    returnUrl: z.url().optional().describe("Zeptly URL the end user's browser returns to (origin must be allow-listed)"),
    credentials: Credentials.optional(),
  })
  .refine((v) => Boolean(v.channel ?? v.network), { message: "channel is required" })
  .refine((v) => !(v.channel && v.network && v.channel !== v.network), { message: "channel and network differ" })
  .meta({ id: "CreateConnectionRequest" });

export const ReconnectRequestSchema = z
  .object({ returnUrl: z.url().optional(), credentials: Credentials.optional() })
  .meta({ id: "ReconnectRequest" });

const ReconcileSummary = z.object({ checked: z.number(), changed: z.number(), adopted: z.number() }).meta({ id: "ConnectionReconcileSummary" });

/**
 * Gateway Contract v1 connections. On this gateway every channel is a social
 * network, so (while Social Publishing is composed) connections are returned in
 * their social view: `channel` plus `network` and per-network `capabilities`.
 */
export function registerConnectionRoutes(app: FastifyInstance, rt: OutstandGatewayRuntime): void {
  const r = zapp(app);
  const ctx = rt.ctx;
  const social = Boolean(rt.registry.get("social.publishing"));
  const Connection = social ? SocialConnectionSchema : GatewayConnectionSchema;
  const ConnectionList = z.object({ data: z.array(Connection) }).meta({ id: social ? "SocialConnectionList" : "GatewayConnectionList" });
  const CreateConnectionResponse = z
    .object({ provisioning: ProvisioningSessionSchema, connections: z.array(Connection) })
    .meta({ id: "CreateConnectionResponse" });
  const present = (res: ConnectionResult) => ({ provisioning: res.provisioning, connections: res.connections.map(rt.presentConnection) });

  r.get(
    "/v1/connections/channels",
    { schema: { tags: ["connections"], summary: "Channels this gateway can provision, with connection strategies", security, headers: workspaceHeaders, response: { 200: ChannelList, ...errorResponses } } },
    async () => ({ data: connections.listChannels(ctx) }),
  );

  r.get(
    "/v1/connections",
    {
      schema: {
        tags: ["connections"],
        summary: "List the workspace's connections",
        security,
        headers: workspaceHeaders,
        querystring: z.object({ channel: z.string().max(64).optional(), network: SocialNetworkSchema.optional().describe("Deprecated alias of `channel`"), status: ConnectionStatusSchema.optional() }),
        response: { 200: ConnectionList, ...errorResponses },
      },
    },
    async (req) => {
      const channel = req.query.channel ?? req.query.network;
      const list = await connections.listConnections(ctx, actorOf(req), { ...(channel ? { channel } : {}), ...(req.query.status ? { status: req.query.status } : {}) });
      return { data: list.map(rt.presentConnection) };
    },
  );

  r.post(
    "/v1/connections",
    {
      schema: {
        tags: ["connections"],
        summary: "Initiate provisioning of a provider account",
        description:
          "oauth_redirect / provider_managed: returns a provisioning session with `authorizationUrl`; send the end user's browser there. The provider redirects back through this gateway, which returns the browser to `returnUrl?provisioningId=…&status=…`. credentials (Bluesky): pass `credentials`; the connection is created synchronously.",
        security,
        headers: workspaceHeaders,
        body: CreateConnectionRequestSchema,
        response: { 201: CreateConnectionResponse, ...errorResponses },
      },
    },
    async (req, reply) => {
      const { channel, network, ...rest } = req.body;
      const res = await connections.createConnection(ctx, actorOf(req), { channel: (channel ?? network) as string, ...rest });
      return reply.status(201).send(present(res));
    },
  );

  r.post(
    "/v1/connections/reconcile",
    {
      schema: {
        tags: ["connections"],
        summary: "Reconcile this workspace's connections with the provider (health, expiry, lost finalizations)",
        security,
        headers: workspaceHeaders,
        response: { 200: ReconcileSummary, ...errorResponses },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      return connections.reconcileConnections(ctx, actor, actor.workspace);
    },
  );

  r.get(
    "/v1/connections/:id",
    { schema: { tags: ["connections"], summary: "Get a connection", security, headers: workspaceHeaders, params: IdParams, response: { 200: Connection, ...errorResponses } } },
    async (req) => rt.presentConnection(await connections.getConnection(ctx, actorOf(req), req.params.id)),
  );

  r.post(
    "/v1/connections/:id/reconnect",
    {
      schema: {
        tags: ["connections"],
        summary: "Start reauthorization of an existing connection",
        security,
        headers: workspaceHeaders,
        params: IdParams,
        body: ReconnectRequestSchema,
        response: { 201: CreateConnectionResponse, ...errorResponses },
      },
    },
    async (req, reply) => reply.status(201).send(present(await connections.reconnectConnection(ctx, actorOf(req), req.params.id, req.body ?? {}))),
  );

  r.delete(
    "/v1/connections/:id",
    { schema: { tags: ["connections"], summary: "Disconnect a connection (removes it at the provider)", security, headers: workspaceHeaders, params: IdParams, response: { 200: Connection, ...errorResponses } } },
    async (req) => rt.presentConnection(await connections.disconnectConnection(ctx, actorOf(req), req.params.id)),
  );

  r.get(
    "/v1/provisioning/:id",
    { schema: { tags: ["connections"], summary: "Get a provisioning session (options to select when awaiting_selection)", security, headers: workspaceHeaders, params: IdParams, response: { 200: ProvisioningSessionSchema, ...errorResponses } } },
    async (req) => connections.getProvisioning(ctx, actorOf(req), req.params.id),
  );

  r.post(
    "/v1/provisioning/:id/finalize",
    {
      schema: {
        tags: ["connections"],
        summary: "Finalize provisioning with the pages/accounts the user selected",
        security,
        headers: workspaceHeaders,
        params: IdParams,
        body: FinalizeProvisioningRequestSchema,
        response: { 200: CreateConnectionResponse, ...errorResponses },
      },
    },
    async (req) => present(await connections.finalizeProvisioning(ctx, actorOf(req), req.params.id, req.body)),
  );

  // Public browser redirect target registered with the provider. Bound to one
  // provisioning session by the unguessable state token in the path.
  r.get(
    "/v1/connect/callback/:state",
    {
      config: { auth: "public" },
      schema: {
        tags: ["connections"],
        summary: "Provider OAuth return (browser redirect; not called by Zeptly)",
        params: z.object({ state: z.string().min(20).max(128) }),
        querystring: z.object({ session: z.string().max(512).optional(), error: z.string().max(512).optional() }).loose(),
      },
    },
    async (req, reply) => {
      try {
        const location = await connections.handleProviderCallback(ctx, req.params.state, req.query);
        return reply.redirect(location, 303);
      } catch (err) {
        if (err instanceof GatewayError && err.code === "PROVISIONING_NOT_FOUND") {
          return reply.status(404).type("text/plain").send("This connection link is invalid or has already been used.");
        }
        throw err;
      }
    },
  );
}
