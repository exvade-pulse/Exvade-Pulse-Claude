import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { sources, suggestions, users } from "../db/schema.js";
import { approveSuggestion, editSuggestion, rejectSuggestion, SuggestionApplyError } from "../suggestions/apply.js";

export async function suggestionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { status?: string } }>("/api/suggestions", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    // No explicit status means "awaiting a review decision" -- an edited
    // suggestion hasn't been approved/rejected yet, so it belongs in that set too.
    const statusFilter = request.query.status
      ? eq(suggestions.status, request.query.status as never)
      : inArray(suggestions.status, ["pending", "edited"]);

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
        reviewedAt: suggestions.reviewedAt,
        // Resolved the same way activity.ts resolves auditLog.actorId -- a left
        // join so a not-yet-reviewed suggestion (reviewedBy null) still returns
        // a row instead of being dropped.
        reviewerName: users.name,
        reviewerEmail: users.email,
        source: {
          type: sources.type,
          externalId: sources.externalId,
          receivedAt: sources.receivedAt,
        },
      })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .leftJoin(users, eq(users.id, suggestions.reviewedBy))
      .where(and(eq(suggestions.organizationId, organizationId), statusFilter))
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

  app.patch<{ Params: { id: string }; Body: { proposedDiff?: Record<string, unknown> } }>(
    "/api/suggestions/:id",
    async (request, reply) => {
      const diff = request.body?.proposedDiff;
      if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
        reply.code(400).send({ error: "proposedDiff is required" });
        return;
      }
      try {
        const updated = await editSuggestion(db, {
          organizationId: request.user!.organizationId,
          suggestionId: request.params.id,
          actorId: request.user!.userId,
          diff,
        });
        reply.send({ suggestion: updated });
      } catch (err) {
        if (err instanceof SuggestionApplyError) {
          reply.code(409).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

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
