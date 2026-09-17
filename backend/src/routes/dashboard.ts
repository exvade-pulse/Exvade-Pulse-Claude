import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { initiatives, objectives, projects, tasks } from "../db/schema.js";
import { emptyTaskCounts, type TaskCounts } from "../tasks/rollup.js";
import { taskParentChainQuery } from "../tasks/parentChain.js";
import { blockingDecisionsForTasks } from "../tasks/blockingDecisions.js";
import { taskSourceCounts } from "../tasks/sourceCounts.js";
import { visibilityFilter } from "../access/visibility.js";

// Shared by needs-attention's in-memory sort: critical/high/medium/low, an
// objective-level-only field (see schema.ts's task table -- tasks have no
// priority of their own), so this ranks a task by the priority of the
// objective it rolls up to.
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/dashboard/objectives", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    // Leadership view: surface what needs attention first -- critical/high priority
    // objectives before low, ties broken alphabetically for a stable order.
    const priorityRank = sql`case ${objectives.priority}
      when 'critical' then 0
      when 'high' then 1
      when 'medium' then 2
      else 3
    end`;

    const objectiveRows = await db
      .select({
        id: objectives.id,
        title: objectives.title,
        description: objectives.description,
        status: objectives.status,
        priority: objectives.priority,
        owner: objectives.owner,
        createdAt: objectives.createdAt,
        updatedAt: objectives.updatedAt,
      })
      .from(objectives)
      .where(eq(objectives.organizationId, organizationId))
      .orderBy(priorityRank, objectives.title);

    const initiativeCounts = await db
      .select({ objectiveId: initiatives.objectiveId, count: count() })
      .from(initiatives)
      .where(eq(initiatives.organizationId, organizationId))
      .groupBy(initiatives.objectiveId);

    // Tasks carry organizationId directly, so this filters correctly without
    // relying on the join chain -- the joins here are purely to recover which
    // objective each task rolls up to.
    const taskStatusCounts = await db
      .select({ objectiveId: initiatives.objectiveId, status: tasks.status, count: count() })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(initiatives, eq(initiatives.id, projects.initiativeId))
      .where(eq(tasks.organizationId, organizationId))
      .groupBy(initiatives.objectiveId, tasks.status);

    const initiativeCountByObjective = new Map(initiativeCounts.map((row) => [row.objectiveId, row.count]));
    const taskCountsByObjective = new Map<string, TaskCounts>();
    for (const row of taskStatusCounts) {
      const counts = taskCountsByObjective.get(row.objectiveId) ?? emptyTaskCounts();
      counts[row.status] = row.count;
      taskCountsByObjective.set(row.objectiveId, counts);
    }

    const result = objectiveRows.map((objective) => ({
      ...objective,
      initiativeCount: initiativeCountByObjective.get(objective.id) ?? 0,
      taskCounts: taskCountsByObjective.get(objective.id) ?? emptyTaskCounts(),
    }));

    reply.send({ objectives: result });
  });

  // Org-wide task-status counts, independent of which objective a task rolls
  // up to -- the "what's the state of the company's tasks, period" strip at
  // the top of the dashboard, as opposed to /api/dashboard/objectives' per-
  // objective breakdown.
  app.get("/api/dashboard/status-summary", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    const statusCounts = await db
      .select({ status: tasks.status, count: count() })
      .from(tasks)
      .where(eq(tasks.organizationId, organizationId))
      .groupBy(tasks.status);

    const counts = emptyTaskCounts();
    for (const row of statusCounts) counts[row.status] = row.count;

    reply.send({ taskCounts: counts });
  });

  // Same join-up-the-chain shape as companyMap.ts's GET /api/tasks/:id, but
  // across every blocked/needs_attention task in the org at once rather than
  // one task's full detail -- a single set-based query (not N+1 per task),
  // scoped at every join so a task can never surface via another org's
  // project/initiative/objective row.
  app.get("/api/dashboard/needs-attention", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    const rows = await taskParentChainQuery(
      db,
      organizationId,
      and(inArray(tasks.status, ["blocked", "needs_attention"]), visibilityFilter(request.user!.role, tasks.visibility)),
    );

    // Sort-only priority lookup: a batched query keyed by objective id rather
    // than pulling objectives.priority into the join above, so
    // taskParentChainQuery's shared shape doesn't need a sort-only column
    // bolted on for this one caller.
    const objectiveIds = [...new Set(rows.map((row) => row.objective.id))];
    const priorityRows =
      objectiveIds.length === 0
        ? []
        : await db
            .select({ id: objectives.id, priority: objectives.priority })
            .from(objectives)
            .where(and(eq(objectives.organizationId, organizationId), inArray(objectives.id, objectiveIds)));
    const priorityByObjective = new Map(priorityRows.map((row) => [row.id, row.priority]));

    // Three-factor sort, done in memory rather than as a SQL ORDER BY: a
    // CASE-ranked priority pulled across a joined parent chain is more SQL
    // than this data scale warrants, and this codebase's established pattern
    // (see companyMap.ts) is a small number of flat queries assembled/sorted
    // in JS rather than one large multi-join query.
    //
    // 1. Severity: blocked outranks needs_attention.
    // 2. Priority: the task's inherited objective priority, critical first.
    // 3. Staleness, ascending (oldest updatedAt first) -- deliberately the
    //    reverse of "most recently updated first". A task that's been quietly
    //    stuck for weeks is a bigger risk than one that became blocked an
    //    hour ago; surfacing neglect matters more here than surfacing
    //    freshness. Don't "fix" this back to desc without re-reading this comment.
    const severityRank: Record<string, number> = { blocked: 0, needs_attention: 1 };
    rows.sort((a, b) => {
      const severityDiff = severityRank[a.status] - severityRank[b.status];
      if (severityDiff !== 0) return severityDiff;

      const priorityDiff =
        PRIORITY_RANK[priorityByObjective.get(a.objective.id)!] - PRIORITY_RANK[priorityByObjective.get(b.objective.id)!];
      if (priorityDiff !== 0) return priorityDiff;

      return a.updatedAt.getTime() - b.updatedAt.getTime();
    });

    const taskIds = rows.map((row) => row.id);
    const [blockingDecisionByTaskId, sourceCountByTaskId] = await Promise.all([
      blockingDecisionsForTasks(db, organizationId, taskIds),
      taskSourceCounts(db, organizationId, taskIds),
    ]);

    const result = rows.map((task) => ({
      ...task,
      blockingDecision: blockingDecisionByTaskId.get(task.id) ?? null,
      sourceCount: sourceCountByTaskId.get(task.id) ?? 0,
    }));

    reply.send({ tasks: result });
  });

  // "Confirmed forward movement only" -- tasks that have actually landed
  // (completed/resolved), most recent first, capped at 10 so this reads as a
  // recent-highlights list rather than a full history (that's what /activity
  // is for). Superseded is deliberately excluded: a superseded task didn't
  // resolve, it was replaced, which isn't the same signal as progress.
  app.get("/api/dashboard/recent-progress", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    const rows = await taskParentChainQuery(
      db,
      organizationId,
      and(inArray(tasks.status, ["completed", "resolved"]), visibilityFilter(request.user!.role, tasks.visibility)),
    )
      .orderBy(desc(tasks.updatedAt))
      .limit(10);

    const sourceCountByTaskId = await taskSourceCounts(db, organizationId, rows.map((row) => row.id));
    const result = rows.map((task) => ({ ...task, sourceCount: sourceCountByTaskId.get(task.id) ?? 0 }));

    reply.send({ tasks: result });
  });
}
