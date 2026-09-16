import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { initiatives, objectives, projects, tasks } from "../db/schema.js";
import { emptyTaskCounts, type TaskCounts } from "../tasks/rollup.js";

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

    // Blocked reads as more urgent than needs_attention; updatedAt desc as
    // the tie-break surfaces whichever of those just changed most recently.
    const statusRank = sql`case ${tasks.status} when 'blocked' then 0 when 'needs_attention' then 1 else 2 end`;

    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        owner: tasks.owner,
        latestUpdate: tasks.latestUpdate,
        nextAction: tasks.nextAction,
        updatedAt: tasks.updatedAt,
        project: { id: projects.id, title: projects.title },
        initiative: { id: initiatives.id, title: initiatives.title },
        objective: { id: objectives.id, title: objectives.title },
      })
      .from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.organizationId, organizationId)))
      .innerJoin(
        initiatives,
        and(eq(initiatives.id, projects.initiativeId), eq(initiatives.organizationId, organizationId)),
      )
      .innerJoin(objectives, and(eq(objectives.id, initiatives.objectiveId), eq(objectives.organizationId, organizationId)))
      .where(and(eq(tasks.organizationId, organizationId), inArray(tasks.status, ["blocked", "needs_attention"])))
      .orderBy(statusRank, desc(tasks.updatedAt));

    reply.send({ tasks: rows });
  });

  // "Confirmed forward movement only" -- tasks that have actually landed
  // (completed/resolved), most recent first, capped at 10 so this reads as a
  // recent-highlights list rather than a full history (that's what /activity
  // is for). Superseded is deliberately excluded: a superseded task didn't
  // resolve, it was replaced, which isn't the same signal as progress.
  app.get("/api/dashboard/recent-progress", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        owner: tasks.owner,
        latestUpdate: tasks.latestUpdate,
        nextAction: tasks.nextAction,
        updatedAt: tasks.updatedAt,
        project: { id: projects.id, title: projects.title },
        initiative: { id: initiatives.id, title: initiatives.title },
        objective: { id: objectives.id, title: objectives.title },
      })
      .from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.organizationId, organizationId)))
      .innerJoin(
        initiatives,
        and(eq(initiatives.id, projects.initiativeId), eq(initiatives.organizationId, organizationId)),
      )
      .innerJoin(objectives, and(eq(objectives.id, initiatives.objectiveId), eq(objectives.organizationId, organizationId)))
      .where(and(eq(tasks.organizationId, organizationId), inArray(tasks.status, ["completed", "resolved"])))
      .orderBy(desc(tasks.updatedAt))
      .limit(10);

    reply.send({ tasks: rows });
  });
}
