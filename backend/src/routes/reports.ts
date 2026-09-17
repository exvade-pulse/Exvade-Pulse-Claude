import type { FastifyInstance } from "fastify";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { decisions, sources, suggestions, tasks } from "../db/schema.js";
import { taskParentChainQuery } from "../tasks/parentChain.js";
import { visibilityFilter } from "../access/visibility.js";

const WEEK_OF_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Monday-start weeks, computed in UTC, as a half-open range
// [weekStart, weekEndExclusive) -- a task updated at exactly the following
// Monday 00:00:00.000 UTC belongs to next week, not this one. `weekOf` may be
// any date within the target week (it need not itself be a Monday); it
// defaults to the current week when omitted.
function computeWeekRange(weekOf: string | undefined): { weekStart: Date; weekEndExclusive: Date } {
  const anchor = weekOf ? new Date(`${weekOf}T00:00:00.000Z`) : new Date();
  const day = anchor.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const weekStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + diffToMonday));
  const weekEndExclusive = new Date(weekStart.getTime() + 7 * MS_PER_DAY);
  return { weekStart, weekEndExclusive };
}

export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // A deterministic roll-up of a single week's real data -- no Claude call,
  // no generated summary paragraph. Every figure here is a direct read (or an
  // in-memory group/count) of rows that already exist, traceable back to the
  // sources appendix at the bottom, matching this app's "every AI-driven
  // change is traceable" principle applied to reporting rather than to a
  // single suggestion.
  app.get<{ Querystring: { weekOf?: string } }>("/api/reports/weekly", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const { weekOf } = request.query;

    if (weekOf && !WEEK_OF_RE.test(weekOf)) {
      reply.code(400).send({ error: "weekOf must be an ISO date (YYYY-MM-DD)" });
      return;
    }

    const { weekStart, weekEndExclusive } = computeWeekRange(weekOf);

    // Current-state, not date-filtered: every open decision and every
    // currently blocked task is relevant to "what does someone reading this
    // report need to know right now", regardless of when it was created.
    const decisionsNeeded = await db
      .select({ id: decisions.id, title: decisions.title, decider: decisions.decider, dueDate: decisions.dueDate })
      .from(decisions)
      .where(
        and(
          eq(decisions.organizationId, organizationId),
          eq(decisions.status, "open"),
          visibilityFilter(request.user!.role, decisions.visibility),
        ),
      )
      .orderBy(sql`${decisions.dueDate} is null`, decisions.dueDate);

    const blockerRows = await taskParentChainQuery(
      db,
      organizationId,
      and(eq(tasks.status, "blocked"), visibilityFilter(request.user!.role, tasks.visibility)),
    );
    const blockers = blockerRows
      .map((row) => ({
        id: row.id,
        title: row.title,
        owner: row.owner,
        project: row.project,
        initiative: row.initiative,
        objective: row.objective,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));

    // The actual "meaningful update during the week" set: tasks whose
    // updatedAt falls in [weekStart, weekEndExclusive), grouped by objective
    // below to read as per-workstream sections.
    const updatedRows = await taskParentChainQuery(
      db,
      organizationId,
      and(
        gte(tasks.updatedAt, weekStart),
        lt(tasks.updatedAt, weekEndExclusive),
        visibilityFilter(request.user!.role, tasks.visibility),
      ),
    );

    const updatedTaskIds = updatedRows.map((row) => row.id);

    // The traceability chain: an approved suggestion targeting one of this
    // week's updated tasks, reviewed within the same week, is the evidence
    // that backs that update. A task updated by some other means (a manual
    // edit, for instance) simply has a zero source count -- not every update
    // need trace to a suggestion, but every one that does must be citable.
    const backingSuggestions =
      updatedTaskIds.length === 0
        ? []
        : await db
            .select({
              targetId: suggestions.targetId,
              source: { id: sources.id, type: sources.type, externalId: sources.externalId, receivedAt: sources.receivedAt },
            })
            .from(suggestions)
            .innerJoin(sources, eq(sources.id, suggestions.sourceId))
            .where(
              and(
                eq(suggestions.organizationId, organizationId),
                eq(suggestions.targetType, "task"),
                inArray(suggestions.targetId, updatedTaskIds),
                eq(suggestions.status, "approved"),
                gte(suggestions.reviewedAt, weekStart),
                lt(suggestions.reviewedAt, weekEndExclusive),
              ),
            );

    const sourceCountByTask = new Map<string, number>();
    const sourcesById = new Map<string, { id: string; type: string; externalId: string; receivedAt: Date }>();
    for (const row of backingSuggestions) {
      const taskId = row.targetId as string;
      sourceCountByTask.set(taskId, (sourceCountByTask.get(taskId) ?? 0) + 1);
      sourcesById.set(row.source.id, row.source);
    }

    const workstreamByObjective = new Map<
      string,
      { objectiveId: string; objectiveTitle: string; tasks: Array<{ id: string; title: string; owner: string | null; latestUpdate: string | null; nextAction: string | null; sourceCount: number }> }
    >();
    for (const row of updatedRows) {
      const entry = workstreamByObjective.get(row.objective.id) ?? {
        objectiveId: row.objective.id,
        objectiveTitle: row.objective.title,
        tasks: [],
      };
      entry.tasks.push({
        id: row.id,
        title: row.title,
        owner: row.owner,
        latestUpdate: row.latestUpdate,
        nextAction: row.nextAction,
        sourceCount: sourceCountByTask.get(row.id) ?? 0,
      });
      workstreamByObjective.set(row.objective.id, entry);
    }

    const workstreams = [...workstreamByObjective.values()]
      .map((ws) => ({ ...ws, tasks: ws.tasks.sort((a, b) => a.title.localeCompare(b.title)) }))
      .sort((a, b) => a.objectiveTitle.localeCompare(b.objectiveTitle));

    const sourcesAppendix = [...sourcesById.values()].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());

    reply.send({
      weekStart: formatDateOnly(weekStart),
      // Display end is the last day of the range (Sunday), not the
      // half-open exclusive boundary used for filtering above.
      weekEnd: formatDateOnly(new Date(weekEndExclusive.getTime() - MS_PER_DAY)),
      decisionsNeeded,
      blockers,
      workstreams,
      sources: sourcesAppendix,
      taskCount: updatedRows.length,
    });
  });
}
