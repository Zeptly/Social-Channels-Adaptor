import { OUTSTAND_REGISTRY_VERSION } from "@zeptly-social/capability-registry";
import { connections, type ServiceContext } from "@zeptly-social/core";
import {
  ConnectionStatusSchema,
  CreateConnectionRequestSchema,
  CreateConnectionResponseSchema,
  FinalizeProvisioningRequestSchema,
  NetworkDescriptorSchema,
  ProvisioningSessionSchema,
  ReconnectRequestSchema,
  SocialConnectionSchema,
  SocialError,
  SocialNetworkSchema,
} from "@zeptly-social/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, errorResponses } from "../app.js";
import { IdParams, security, workspaceHeaders, zapp } from "./common.js";

const ConnectionList = z.object({ data: z.array(SocialConnectionSchema) }).meta({ id: "SocialConnectionList" });
const NetworkList = z.object({ data: z.array(NetworkDescriptorSchema), registryVersion: z.string() }).meta({ id: "NetworkList" });
const ReconcileSummary = z.object({ checked: z.number(), changed: z.number(), adopted: z.number() }).meta({ id: "ConnectionReconcileSummary" });

export function registerConnectionRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  const r = zapp(app);

  r.get(
    "/v1/networks",
    { schema: { tags: ["networks"], summary: "Supported networks, connection strategies, capabilities and constraints", security, headers: workspaceHeaders, response: { 200: NetworkList, ...errorResponses } } },
    async () => ({ data: connections.listNetworks(ctx), registryVersion: OUTSTAND_REGISTRY_VERSION }),
  );

  r.get(
    "/v1/connections",
    {
      schema: {
        tags: ["connections"],
        summary: "List the workspace's social connections",
        security,
        headers: workspaceHeaders,
        querystring: z.object({ network: SocialNetworkSchema.optional(), status: ConnectionStatusSchema.optional() }),
        response: { 200: ConnectionList, ...errorResponses },
      },
    },
    async (req) => ({ data: await connections.listConnections(ctx, actorOf(req), req.query) }),
  );

  r.post(
    "/v1/connections",
    {
      schema: {
        tags: ["connections"],
        summary: "Initiate provisioning of a social account",
        description:
          "oauth_redirect / provider_managed: returns a provisioning session with `authorizationUrl`; send the end user's browser there. The provider redirects back through this service, which returns the browser to `returnUrl?provisioningId=…&status=…`. credentials (Bluesky): pass `credentials`; the connection is created synchronously.",
        security,
        headers: workspaceHeaders,
        body: CreateConnectionRequestSchema,
        response: { 201: CreateConnectionResponseSchema, ...errorResponses },
      },
    },
    async (req, reply) => reply.status(201).send(await connections.createConnection(ctx, actorOf(req), req.body)),
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
    { schema: { tags: ["connections"], summary: "Get a connection", security, headers: workspaceHeaders, params: IdParams, response: { 200: SocialConnectionSchema, ...errorResponses } } },
    async (req) => connections.getConnection(ctx, actorOf(req), req.params.id),
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
        response: { 201: CreateConnectionResponseSchema, ...errorResponses },
      },
    },
    async (req, reply) => reply.status(201).send(await connections.reconnectConnection(ctx, actorOf(req), req.params.id, req.body ?? {})),
  );

  r.delete(
    "/v1/connections/:id",
    { schema: { tags: ["connections"], summary: "Disconnect a connection (removes it at the provider)", security, headers: workspaceHeaders, params: IdParams, response: { 200: SocialConnectionSchema, ...errorResponses } } },
    async (req) => connections.disconnectConnection(ctx, actorOf(req), req.params.id),
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
        response: { 200: CreateConnectionResponseSchema, ...errorResponses },
      },
    },
    async (req) => connections.finalizeProvisioning(ctx, actorOf(req), req.params.id, req.body),
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
        if (err instanceof SocialError && err.code === "PROVISIONING_NOT_FOUND") {
          return reply.status(404).type("text/plain").send("This connection link is invalid or has already been used.");
        }
        throw err;
      }
    },
  );
}
