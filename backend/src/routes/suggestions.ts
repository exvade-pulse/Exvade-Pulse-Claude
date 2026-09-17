import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { decisions, initiatives, objectives, projects, sources, suggestions, tasks, users } from "../db/schema.js";
import { approveSuggestion, editSuggestion, rejectSuggestion, SuggestionApplyError } from "../suggestions/apply.js";

// Every targetType a suggestion can carry, including "decision" -- unlike
// apply.ts's own TABLE_BY_TARGET_TYPE (which deliberately excludes decision
// because approving one needs createDecision/updateDecision's own
// validation), this is read-only lookup for the review UI's "current state"
// column, where a decision's row is exactly as fetchable as any other target.
const CURRENT_STATE_TABLE = {
  objective: objectives,
  initiative: initiatives,
  project: projects,
  task: tasks,
  decision: decisions,
} as const;

// Batch-fetches the current row for every (targetType, targetId) pair among
// the given suggestions -- one query per targetType actually present, not
// N+1 per suggestion. Keyed by "targetType:targetId" since ids aren't
// necessarily unique across different target tables.
async function loadCurrentStates(
  organizationId: string,
  rows: Array<{ targetType: string; targetId: string | null }>,
): Promise<Map<string, Record<string, unknown>>> {
  const idsByType = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.targetId === null) continue;
    const set = idsByType.get(row.targetType) ?? new Set<string>();
    set.add(row.targetId);
    idsByType.set(row.targetType, set);
  }

  const result = new Map<string, Record<string, unknown>>();
  await Promise.all(
    [...idsByType.entries()].map(async ([targetType, idSet]) => {
      const table = CURRENT_STATE_TABLE[targetType as keyof typeof CURRENT_STATE_TABLE];
      if (!table) return;
      const currentRows = await db
        .select()
        .from(table)
        .where(and(eq(table.organizationId, organizationId), inArray(table.id, [...idSet])));
      for (const currentRow of currentRows) {
        result.set(`${targetType}:${currentRow.id}`, currentRow as Record<string, unknown>);
      }
    }),
  );
  return result;
}

// Narrows a fetched current row down to just the fields the suggestion's own
// proposedDiff touches, so the review UI can render "current -> proposed"
// pairs for exactly what's changing, not the entire row.
function pickCurrentStateFields(
  currentRow: Record<string, unknown> | undefined,
  proposedDiff: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!currentRow) return null;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(proposedDiff)) {
    if (key in currentRow) result[key] = currentRow[key];
  }
  return result;
}

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
          id: sources.id,
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

    const currentStates = await loadCurrentStates(organizationId, rows);
    const withCurrentState = rows.map((row) => ({
      ...row,
      // null for a brand-new entity (targetId null) or a target that no
      // longer resolves (shouldn't happen today -- nothing deletes rows --
      // but fails safe rather than crashing the response).
      currentState: pickCurrentStateFields(
        row.targetId ? currentStates.get(`${row.targetType}:${row.targetId}`) : undefined,
        row.proposedDiff as Record<string, unknown>,
      ),
    }));

    reply.send({ suggestions: withCurrentState });
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
