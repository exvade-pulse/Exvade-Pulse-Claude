import type { FastifyInstance } from "fastify";
import { count, eq, sql } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { initiatives, objectives, projects, taskStatusEnum, tasks } from "../db/schema.js";

const TASK_STATUSES = taskStatusEnum.enumValues;

type TaskStatus = (typeof TASK_STATUSES)[number];
type TaskCounts = Record<TaskStatus, number>;

function emptyTaskCounts(): TaskCounts {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as TaskCounts;
}

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
}
