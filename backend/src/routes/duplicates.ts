import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { projects, sources, tasks } from "../db/schema.js";
import { findDuplicateTasks } from "../interpretation/duplicateDetection.js";
import { getClaudeClient } from "../interpretation/claudeClient.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";

// Same reasoning as unsorted.ts's retriage exclusion: a completed/resolved/
// superseded task is already a closed matter, so there's nothing useful in
// flagging it (or comparing other tasks against it) as a duplicate.
const DUPLICATE_CHECK_EXCLUDED_STATUSES: Array<"completed" | "resolved" | "superseded"> = [
  "completed",
  "resolved",
  "superseded",
];

export async function duplicateRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // On-demand (never automatic): checks every project with two or more
  // open tasks for genuine duplicates -- one Claude call per project, not
  // per task pair, so cost scales with project count rather than task count
  // squared. A found duplicate proposes marking the lesser copy
  // "superseded" (an existing, otherwise-unused task status meant for
  // exactly this) as an ordinary suggestion in the normal review queue,
  // rather than touching anything itself.
  app.post("/api/tasks/check-duplicates", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    const projectRows = await db.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, organizationId));

    let projectsChecked = 0;
    let tasksChecked = 0;
    let duplicatesFound = 0;

    if (projectRows.length === 0) {
      reply.send({ projectsChecked, tasksChecked, duplicatesFound });
      return;
    }

    const claudeClient = getClaudeClient();
    const receivedAt = new Date();
    let sourceId: string | null = null;

    for (const project of projectRows) {
      const taskRows = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          description: tasks.description,
          latestUpdate: tasks.latestUpdate,
          nextAction: tasks.nextAction,
          status: tasks.status,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, project.id),
            eq(tasks.organizationId, organizationId),
            notInArray(tasks.status, DUPLICATE_CHECK_EXCLUDED_STATUSES),
          ),
        );

      if (taskRows.length < 2) continue;
      projectsChecked++;
      tasksChecked += taskRows.length;

      const pairs = await findDuplicateTasks(taskRows, claudeClient);
      if (pairs.length === 0) continue;

      // Created lazily, on the first real finding -- most runs across most
      // orgs will find nothing, and there's no reason to leave a source row
      // behind (or take the extra insert) for a check that turned up empty.
      if (sourceId === null) {
        const [source] = await db
          .insert(sources)
          .values({
            organizationId,
            type: "manual",
            externalId: randomUUID(),
            receivedAt,
            rawBody: `Automated duplicate-task check across ${projectRows.length} project(s).`,
          })
          .returning();
        sourceId = source.id;
      }

      const taskById = new Map(taskRows.map((t) => [t.id, t]));
      for (const pair of pairs) {
        const keepTask = taskById.get(pair.keepTaskId);
        if (!keepTask) continue;

        await mergeOrInsertSuggestion(db, {
          organizationId,
          sourceId,
          sourceReceivedAt: receivedAt,
          draft: {
            changeType: "operational_update",
            targetType: "task",
            targetId: pair.supersedeTaskId,
            proposedDiff: { status: "superseded", latestUpdate: `Superseded by duplicate task: "${keepTask.title}"` },
            reasoning: pair.reasoning,
            confidence: pair.confidence,
          },
        });
        duplicatesFound++;
      }
    }

    reply.send({ projectsChecked, tasksChecked, duplicatesFound });
  });
}
