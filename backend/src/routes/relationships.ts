import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { entityNodeTypeEnum, relationTypeEnum, type EntityNodeType, type RelationType } from "../db/schema.js";
import {
  createRelationship,
  deleteRelationship,
  listRelationshipsForEntity,
  RelationshipError,
} from "../relationships/manage.js";
import { UUID_RE } from "./uuid.js";

const VALID_ENTITY_TYPES = new Set<string>(entityNodeTypeEnum.enumValues);
const VALID_RELATION_TYPES = new Set<string>(relationTypeEnum.enumValues);

export async function relationshipRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { entityType?: string; entityId?: string } }>(
    "/api/relationships",
    async (request, reply) => {
      const { entityType, entityId } = request.query;
      if (!entityType || !VALID_ENTITY_TYPES.has(entityType)) {
        reply.code(400).send({ error: "entityType must be a valid entity type" });
        return;
      }
      if (!entityId || !UUID_RE.test(entityId)) {
        reply.code(400).send({ error: "entityId must be a valid uuid" });
        return;
      }

      const relationships = await listRelationshipsForEntity(
        db,
        request.user!.organizationId,
        entityType as EntityNodeType,
        entityId,
      );
      reply.send({ relationships });
    },
  );

  app.post<{
    Body: {
      fromType?: string;
      fromId?: string;
      toType?: string;
      toId?: string;
      relationType?: string;
      note?: string | null;
    };
  }>("/api/relationships", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.fromType || !VALID_ENTITY_TYPES.has(body.fromType)) {
      reply.code(400).send({ error: "fromType must be a valid entity type" });
      return;
    }
    if (!body.fromId || !UUID_RE.test(body.fromId)) {
      reply.code(400).send({ error: "fromId must be a valid uuid" });
      return;
    }
    if (!body.toType || !VALID_ENTITY_TYPES.has(body.toType)) {
      reply.code(400).send({ error: "toType must be a valid entity type" });
      return;
    }
    if (!body.toId || !UUID_RE.test(body.toId)) {
      reply.code(400).send({ error: "toId must be a valid uuid" });
      return;
    }
    if (!body.relationType || !VALID_RELATION_TYPES.has(body.relationType)) {
      reply.code(400).send({ error: "relationType must be a valid relation type" });
      return;
    }

    try {
      const relationship = await createRelationship(db, {
        organizationId: request.user!.organizationId,
        actorId: request.user!.userId,
        fromType: body.fromType as EntityNodeType,
        fromId: body.fromId,
        toType: body.toType as EntityNodeType,
        toId: body.toId,
        relationType: body.relationType as RelationType,
        note: body.note ?? null,
      });
      reply.code(201).send({ relationship });
    } catch (err) {
      if (err instanceof RelationshipError) {
        reply.code(err.code === "not_found" ? 404 : 400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/relationships/:id", async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) {
      reply.code(404).send({ error: "Relationship not found" });
      return;
    }
    const deleted = await deleteRelationship(db, request.user!.organizationId, request.params.id);
    if (!deleted) {
      reply.code(404).send({ error: "Relationship not found" });
      return;
    }
    reply.send({ ok: true });
  });
}
