import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { sources, suggestions } from "../db/schema.js";
import { approveSuggestion, rejectSuggestion, SuggestionApplyError } from "../suggestions/apply.js";

export async function suggestionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { status?: string } }>("/api/suggestions", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const status = request.query.status ?? "pending";

    const rows = await db
      .select({
        id: suggestions.id,
        targetType: suggestions.targetType,
        targetId: suggestions.targetId,
        changeType: suggestions.changeType,
        proposedDiff: suggestions.proposedDiff,
        reasoning: suggestions.reasoning,
        confidence: suggestions.confidence,
        status: suggestions.status,
        createdAt: suggestions.createdAt,
        source: {
          type: sources.type,
          externalId: sources.externalId,
          receivedAt: sources.receivedAt,
        },
      })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .where(and(eq(suggestions.organizationId, organizationId), eq(suggestions.status, status as never)))
      .orderBy(desc(suggestions.createdAt));

    reply.send({ suggestions: rows });
  });

  app.post<{ Params: { id: string } }>("/api/suggestions/:id/approve", async (request, reply) => {
    try {
      const updated = await approveSuggestion(db, {
        organizationId: request.user!.organizationId,
        suggestionId: request.params.id,
        reviewerId: request.user!.userId,
      });
      reply.send({ suggestion: updated });
    } catch (err) {
      if (err instanceof SuggestionApplyError) {
        reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/suggestions/:id/reject", async (request, reply) => {
    try {
      const updated = await rejectSuggestion(db, {
        organizationId: request.user!.organizationId,
        suggestionId: request.params.id,
        reviewerId: request.user!.userId,
      });
      reply.send({ suggestion: updated });
    } catch (err) {
      if (err instanceof SuggestionApplyError) {
        reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
