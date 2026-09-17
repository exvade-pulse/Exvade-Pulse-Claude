import type { FastifyInstance } from "fastify";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import type { IntegrationType } from "../db/schema.js";
import { generateIntegrationToken, listIntegrationActivity, listIntegrations } from "../integrations/manage.js";

const VALID_TYPES: IntegrationType[] = ["circleback", "email"];

export async function integrationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  app.get("/api/integrations", async (request, reply) => {
    const integrations = await listIntegrations(db, request.user!.organizationId);
    reply.send({ integrations });
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
