import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { initiatives, objectives, projects, suggestions, tasks } from "../db/schema.js";

// Route params arrive as arbitrary strings (a stale link, a typo, a poked-at
// URL) -- Postgres throws (not a clean empty result) on a non-UUID literal
// against a uuid column, which would otherwise surface as a 500 instead of
// the 404 a bad id should produce.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function companyMapRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

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
      .select({ id: projects.id, title: projects.title, status: projects.status })
      .from(projects)
      .where(and(eq(projects.initiativeId, id), eq(projects.organizationId, organizationId)))
      .orderBy(projects.title);

    reply.send({ initiative, objective: objective ?? null, projects: projectRows });
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
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, id), eq(tasks.organizationId, organizationId)))
      .orderBy(tasks.title);

    reply.send({ project, initiative: initiative ?? null, tasks: taskRows });
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

    reply.send({
      task,
      project: chain?.project ?? null,
      initiative: chain?.initiative ?? null,
      objective: chain?.objective ?? null,
      approvedSuggestions,
    });
  });
}
