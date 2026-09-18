import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { initiatives, objectives, projects, sources, suggestions, tasks } from "../db/schema.js";
import { suggestReclassification } from "../interpretation/retriage.js";
import { getClaudeClient } from "../interpretation/claudeClient.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";

// The exact title interpret.ts's SYSTEM_PROMPT tells the model to use when a
// task's real project doesn't exist yet -- see that file's comment for why
// this is a real, permanently-existing project rather than a fabricated
// concept. Looked up by title (org-scoped) rather than a stored id, since
// nothing else in the schema marks a project as "the" catchall.
const UNSORTED_PROJECT_TITLE = "Unsorted / Needs Triage";

// Terminal task states aren't worth spending a Claude call re-triaging --
// nothing changes about where completed/resolved/superseded work "belongs"
// that would make moving it now useful to anyone.
const RETRIAGE_EXCLUDED_STATUSES: Array<"completed" | "resolved" | "superseded"> = ["completed", "resolved", "superseded"];

async function findUnsortedProject(organizationId: string) {
  const [project] = await db
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.title, UNSORTED_PROJECT_TITLE)));
  return project ?? null;
}

export async function unsortedRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Flat list of everything currently sitting in the Unsorted catch-all, for
  // a one-click landing page -- the alternative (Company Map, several nested
  // expand-clicks deep) is exactly the "too many clicks" complaint this
  // route exists to fix.
  app.get("/api/unsorted", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const unsortedProject = await findUnsortedProject(organizationId);

    if (!unsortedProject) {
      reply.send({ project: null, tasks: [] });
      return;
    }

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
      .where(and(eq(tasks.projectId, unsortedProject.id), eq(tasks.organizationId, organizationId)))
      .orderBy(tasks.title);

    // A task already has a pending re-triage suggestion when a prior run
    // proposed one and a reviewer hasn't acted on it yet -- surfaced so the
    // page can show "suggestion ready" instead of letting a repeat click on
    // "Suggest where these belong" look like it did nothing (mergeOrInsert
    // will fold into the existing suggestion rather than duplicate it, but
    // the page should still reflect that a proposal already exists).
    const taskIds = taskRows.map((t) => t.id);
    const pendingMoves =
      taskIds.length === 0
        ? []
        : await db
            .select({ targetId: suggestions.targetId, confidence: suggestions.confidence })
            .from(suggestions)
            .where(
              and(
                eq(suggestions.organizationId, organizationId),
                eq(suggestions.targetType, "task"),
                inArray(suggestions.targetId, taskIds),
                inArray(suggestions.status, ["pending", "edited"]),
              ),
            );
    const pendingByTaskId = new Map(pendingMoves.map((p) => [p.targetId as string, p]));

    reply.send({
      project: unsortedProject,
      tasks: taskRows.map((t) => ({
        ...t,
        pendingSuggestion: pendingByTaskId.has(t.id) ? { confidence: pendingByTaskId.get(t.id)!.confidence } : null,
      })),
    });
  });

  // On-demand (never automatic -- each task costs one Claude call): checks
  // every eligible Unsorted task against the company's real projects and
  // proposes a move for any clear match, landing as an ordinary suggestion
  // in the normal review queue rather than moving anything itself.
  app.post("/api/unsorted/retriage", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const unsortedProject = await findUnsortedProject(organizationId);

    if (!unsortedProject) {
      reply.send({ checked: 0, suggested: 0 });
      return;
    }

    const candidateRows = await db
      .select({
        id: projects.id,
        title: projects.title,
        initiativeTitle: initiatives.title,
        objectiveTitle: objectives.title,
      })
      .from(projects)
      .innerJoin(initiatives, and(eq(initiatives.id, projects.initiativeId), eq(initiatives.organizationId, organizationId)))
      .innerJoin(objectives, and(eq(objectives.id, initiatives.objectiveId), eq(objectives.organizationId, organizationId)))
      .where(and(eq(projects.organizationId, organizationId), ne(projects.id, unsortedProject.id)));

    if (candidateRows.length === 0) {
      reply.send({ checked: 0, suggested: 0 });
      return;
    }

    const taskRows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        latestUpdate: tasks.latestUpdate,
        nextAction: tasks.nextAction,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, unsortedProject.id),
          eq(tasks.organizationId, organizationId),
          notInArray(tasks.status, RETRIAGE_EXCLUDED_STATUSES),
        ),
      );

    if (taskRows.length === 0) {
      reply.send({ checked: 0, suggested: 0 });
      return;
    }

    const claudeClient = getClaudeClient();
    const receivedAt = new Date();
    // One synthetic source shared by every suggestion this run produces --
    // there's no external communication behind a re-triage pass, but
    // suggestions.sourceId is required, and the review card's "View source"
    // toggle should show something coherent rather than a blank citation.
    const [source] = await db
      .insert(sources)
      .values({
        organizationId,
        type: "manual",
        externalId: randomUUID(),
        receivedAt,
        rawBody: `Automated re-triage pass over ${taskRows.length} task(s) sitting in "${UNSORTED_PROJECT_TITLE}", checked against ${candidateRows.length} real project(s).`,
      })
      .returning();

    let suggested = 0;
    for (const task of taskRows) {
      const result = await suggestReclassification(task, candidateRows, claudeClient);
      if (!result) continue;

      await mergeOrInsertSuggestion(db, {
        organizationId,
        sourceId: source.id,
        sourceReceivedAt: receivedAt,
        draft: {
          changeType: "operational_update",
          targetType: "task",
          targetId: task.id,
          proposedDiff: { projectId: result.projectId },
          reasoning: result.reasoning,
          confidence: result.confidence,
        },
      });
      suggested++;
    }

    reply.send({ checked: taskRows.length, suggested });
  });
}
