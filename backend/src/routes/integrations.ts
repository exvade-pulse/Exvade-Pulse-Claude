import type { FastifyInstance } from "fastify";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import type { IntegrationType } from "../db/schema.js";
import {
  generateIntegrationToken,
  getGmailConnectionStatus,
  listIntegrationActivity,
  listIntegrations,
} from "../integrations/manage.js";
import { syncGmailConnection } from "../integrations/gmailSync.js";

const VALID_TYPES: IntegrationType[] = ["circleback", "email"];

export async function integrationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  app.get("/api/integrations", async (request, reply) => {
    const [integrations, gmail] = await Promise.all([
      listIntegrations(db, request.user!.organizationId),
      getGmailConnectionStatus(db, request.user!.organizationId),
    ]);
    reply.send({ integrations, gmail });
  });

  // Same underlying query as the (never-connected) "email" webhook
  // integration's activity log -- both read sources.type = "gmail", see
  // manage.ts's GmailConnectionStatus comment.
  app.get("/api/integrations/gmail/activity", async (request, reply) => {
    const activity = await listIntegrationActivity(db, request.user!.organizationId, "email");
    reply.send({ activity });
  });

  // Lets an admin force a check right now (e.g. right after connecting, or
  // to confirm the poller is working) instead of waiting for the next
  // scheduled pass.
  app.post("/api/integrations/gmail/sync", async (request, reply) => {
    try {
      const result = await syncGmailConnection(db, request.user!.organizationId);
      reply.send(result);
    } catch (err) {
      reply.code(502).send({ error: err instanceof Error ? err.message : "Gmail sync failed" });
    }
  });

  app.get<{ Params: { type: string } }>("/api/integrations/:type/activity", async (request, reply) => {
    const type = request.params.type as IntegrationType;
    if (!VALID_TYPES.includes(type)) {
      reply.code(400).send({ error: `Unknown integration type "${request.params.type}"` });
      return;
    }

    const activity = await listIntegrationActivity(db, request.user!.organizationId, type);
    reply.send({ activity });
  });

  app.post<{ Params: { type: string } }>("/api/integrations/:type/token", async (request, reply) => {
    const type = request.params.type as IntegrationType;
    if (!VALID_TYPES.includes(type)) {
      reply.code(400).send({ error: `Unknown integration type "${request.params.type}"` });
      return;
    }

    const result = await generateIntegrationToken(db, {
      organizationId: request.user!.organizationId,
      actorId: request.user!.userId,
      type,
    });

    reply.code(201).send({
      type: result.type,
      token: result.rawToken,
      webhookUrl: result.webhookUrl,
      rotated: result.rotated,
      createdAt: result.createdAt,
      lastReceivedAt: result.lastReceivedAt,
    });
  });
}
