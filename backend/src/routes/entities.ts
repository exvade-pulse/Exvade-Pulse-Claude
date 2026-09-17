import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { createCompanyEntity, listCompanyEntities } from "../entities/manage.js";

export async function entityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/company-entities", async (request, reply) => {
    const entities = await listCompanyEntities(db, request.user!.organizationId);
    reply.send({ entities });
  });

  app.post<{ Body: { name?: string; kind?: string | null; notes?: string | null } }>(
    "/api/company-entities",
    async (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) {
        reply.code(400).send({ error: "name is required" });
        return;
      }

      const entity = await createCompanyEntity(db, {
        organizationId: request.user!.organizationId,
        name,
        kind: request.body?.kind ?? null,
        notes: request.body?.notes ?? null,
      });
      reply.code(201).send({ entity });
    },
  );
}
