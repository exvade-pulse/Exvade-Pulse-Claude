import type { FastifyInstance } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { decisions, initiatives, objectives, projects, suggestions, tasks } from "../db/schema.js";
import { emptyTaskCounts } from "../tasks/rollup.js";
import { UUID_RE } from "./uuid.js";

export async function companyMapRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // The full Objective -> Initiative -> Project -> Task tree in one response,
  // for the Company Map overview page -- assembled in memory from four
  // org-scoped queries (one per level) rather than one query per objective,
  // so this stays flat regardless of how many objectives an org has.
  app.get("/api/company-map", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    const [objectiveRows, initiativeRows, projectRows, taskRows] = await Promise.all([
      db
        .select({
          id: objectives.id,
          title: objectives.title,
          description: objectives.description,
          status: objectives.status,
          priority: objectives.priority,
          owner: objectives.owner,
        })
        .from(objectives)
        .where(eq(objectives.organizationId, organizationId))
        .orderBy(objectives.title),
      db
        .select({
          id: initiatives.id,
          objectiveId: initiatives.objectiveId,
          title: initiatives.title,
          status: initiatives.status,
          priority: initiatives.priority,
          owner: initiatives.owner,
        })
        .from(initiatives)
        .where(eq(initiatives.organizationId, organizationId))
        .orderBy(initiatives.title),
      db
        .select({
          id: projects.id,
          initiativeId: projects.initiativeId,
          title: projects.title,
          status: projects.status,
          owner: projects.owner,
        })
        .from(projects)
        .where(eq(projects.organizationId, organizationId))
        .orderBy(projects.title),
      db
        .select({
          id: tasks.id,
          projectId: tasks.projectId,
          title: tasks.title,
          status: tasks.status,
          latestUpdate: tasks.latestUpdate,
          nextAction: tasks.nextAction,
          owner: tasks.owner,
        })
        .from(tasks)
        .where(eq(tasks.organizationId, organizationId))
        .orderBy(tasks.title),
    ]);

    const tasksByProject = new Map<string, typeof taskRows>();
    for (const task of taskRows) {
      const list = tasksByProject.get(task.projectId) ?? [];
      list.push(task);
      tasksByProject.set(task.projectId, list);
    }

    const projectsByInitiative = new Map<string, Array<(typeof projectRows)[number] & { tasks: typeof taskRows }>>();
    for (const project of projectRows) {
      const list = projectsByInitiative.get(project.initiativeId) ?? [];
      list.push({ ...project, tasks: tasksByProject.get(project.id) ?? [] });
      projectsByInitiative.set(project.initiativeId, list);
    }

    const initiativesByObjective = new Map<
      string,
      Array<(typeof initiativeRows)[number] & { projects: ReturnType<typeof projectsByInitiative.get> }>
    >();
    for (const initiative of initiativeRows) {
      const list = initiativesByObjective.get(initiative.objectiveId) ?? [];
      list.push({ ...initiative, projects: projectsByInitiative.get(initiative.id) ?? [] });
      initiativesByObjective.set(initiative.objectiveId, list);
    }

    const tree = objectiveRows.map((objective) => ({
      ...objective,
      initiatives: initiativesByObjective.get(objective.id) ?? [],
    }));

    reply.send({ objectives: tree });
  });

  app.get<{ Params: { id: string } }>("/api/objectives/:id", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      reply.code(404).send({ error: "Objective not found" });
      return;
    }

    const [objective] = await db
      .select()
      .from(objectives)
      .where(and(eq(objectives.id, id), eq(objectives.organizationId, organizationId)));

    if (!objective) {
      reply.code(404).send({ error: "Objective not found" });
      return;
    }

    const initiativeRows = await db
      .select({
        id: initiatives.id,
        title: initiatives.title,
        status: initiatives.status,
        priority: initiatives.priority,
        owner: initiatives.owner,
      })
      .from(initiatives)
      .where(and(eq(initiatives.objectiveId, id), eq(initiatives.organizationId, organizationId)))
      .orderBy(initiatives.title);

    reply.send({ objective, initiatives: initiativeRows });
  });

  app.get<{ Params: { id: string } }>("/api/initiatives/:id", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      reply.code(404).send({ error: "Initiative not found" });
      return;
    }

    const [initiative] = await db
      .select()
      .from(initiatives)
      .where(and(eq(initiatives.id, id), eq(initiatives.organizationId, organizationId)));

    if (!initiative) {
      reply.code(404).send({ error: "Initiative not found" });
      return;
    }

    const [objective] = await db
      .select({ id: objectives.id, title: objectives.title })
      .from(objectives)
      .where(and(eq(objectives.id, initiative.objectiveId), eq(objectives.organizationId, organizationId)));

    const projectRows = await db
      .select({ id: projects.id, title: projects.title, status: projects.status, owner: projects.owner })
      .from(projects)
      .where(and(eq(projects.initiativeId, id), eq(projects.organizationId, organizationId)))
      .orderBy(projects.title);

    // Same rollup shape as the dashboard's objective cards, one level down --
    // every task across this initiative's projects, joined up through
    // projects to scope by initiativeId (tasks don't carry initiativeId
    // directly).
    const taskStatusCounts = await db
      .select({ status: tasks.status, count: count() })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(projects.initiativeId, id), eq(tasks.organizationId, organizationId)))
      .groupBy(tasks.status);

    const taskCounts = emptyTaskCounts();
    for (const row of taskStatusCounts) taskCounts[row.status] = row.count;

    reply.send({ initiative, objective: objective ?? null, projects: projectRows, taskCounts });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      reply.code(404).send({ error: "Project not found" });
      return;
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.organizationId, organizationId)));

    if (!project) {
      reply.code(404).send({ error: "Project not found" });
      return;
    }

    const [initiative] = await db
      .select({ id: initiatives.id, title: initiatives.title })
      .from(initiatives)
      .where(and(eq(initiatives.id, project.initiativeId), eq(initiatives.organizationId, organizationId)));

    const taskRows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        latestUpdate: tasks.latestUpdate,
        nextAction: tasks.nextAction,
        owner: tasks.owner,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, id), eq(tasks.organizationId, organizationId)))
      .orderBy(tasks.title);

    // Same rollup shape as the initiative endpoint above, scoped to this
    // project's own tasks directly (no join needed -- tasks already carry
    // projectId).
    const taskStatusCounts = await db
      .select({ status: tasks.status, count: count() })
      .from(tasks)
      .where(and(eq(tasks.projectId, id), eq(tasks.organizationId, organizationId)))
      .groupBy(tasks.status);

    const taskCounts = emptyTaskCounts();
    for (const row of taskStatusCounts) taskCounts[row.status] = row.count;

    reply.send({ project, initiative: initiative ?? null, tasks: taskRows, taskCounts });
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      reply.code(404).send({ error: "Task not found" });
      return;
    }

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)));

    if (!task) {
      reply.code(404).send({ error: "Task not found" });
      return;
    }

    // Resolve the full breadcrumb chain in one join rather than three
    // separate round trips -- one page load, one query.
    const [chain] = await db
      .select({
        project: { id: projects.id, title: projects.title },
        initiative: { id: initiatives.id, title: initiatives.title },
        objective: { id: objectives.id, title: objectives.title },
      })
      .from(projects)
      .innerJoin(initiatives, and(eq(initiatives.id, projects.initiativeId), eq(initiatives.organizationId, organizationId)))
      .innerJoin(objectives, and(eq(objectives.id, initiatives.objectiveId), eq(objectives.organizationId, organizationId)))
      .where(and(eq(projects.id, task.projectId), eq(projects.organizationId, organizationId)));

    const approvedSuggestions = await db
      .select({
        id: suggestions.id,
        changeType: suggestions.changeType,
        reasoning: suggestions.reasoning,
        proposedDiff: suggestions.proposedDiff,
        reviewedAt: suggestions.reviewedAt,
      })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, "task"),
          eq(suggestions.targetId, id),
          eq(suggestions.status, "approved"),
        ),
      )
      .orderBy(desc(suggestions.reviewedAt));

    // The "why is this stuck" signal for a blocked/needs_attention task --
    // same open-decision-pointing-at-this-task lookup as the dashboard's
    // needs-attention endpoint, just scoped to a single task here rather than
    // batched across many.
    const [blockingDecision] = await db
      .select({ id: decisions.id, title: decisions.title })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), eq(decisions.status, "open"), eq(decisions.relatedTaskId, id)));

    reply.send({
      task,
      project: chain?.project ?? null,
      initiative: chain?.initiative ?? null,
      objective: chain?.objective ?? null,
      approvedSuggestions,
      blockingDecision: blockingDecision ?? null,
    });
  });
}
