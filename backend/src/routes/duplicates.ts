import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { decisions, LIVE_DECISION_STATUSES, projects, sources, suggestions, tasks, TERMINAL_TASK_STATUSES } from "../db/schema.js";
import { findDuplicateDecisions, findDuplicateTasks } from "../interpretation/duplicateDetection.js";
import { getClaudeClient } from "../interpretation/claudeClient.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";

// A finished task is already a closed matter, so there's nothing useful in
// flagging it (or comparing other tasks against it) as a duplicate.
const DUPLICATE_CHECK_EXCLUDED_STATUSES = TERMINAL_TASK_STATUSES;

export async function duplicateRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // On-demand (never automatic): checks every project with two or more open
  // tasks, plus the org's live decisions, for genuine duplicates -- one
  // Claude call per project and one for decisions, not per pair. A found
  // duplicate becomes a "merge" suggestion in the normal review queue;
  // approving it marks the duplicate superseded and links it to the record
  // kept, deleting nothing (see supersedeTask / supersedeDecision).
  app.post("/api/tasks/check-duplicates", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    let projectsChecked = 0;
    let tasksChecked = 0;
    let duplicatesFound = 0;
    let decisionsChecked = 0;
    let decisionDuplicatesFound = 0;

    const [projectRows, decisionRows, pendingMerges] = await Promise.all([
      db.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, organizationId)),
      db
        .select({
          id: decisions.id,
          title: decisions.title,
          whyItMatters: decisions.whyItMatters,
          relevantContext: decisions.relevantContext,
          decider: decisions.decider,
          dueDate: decisions.dueDate,
          status: decisions.status,
        })
        .from(decisions)
        .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, LIVE_DECISION_STATUSES))),
      // A duplicate already waiting on a merge decision isn't re-proposed.
      db
        .select({ targetId: suggestions.targetId })
        .from(suggestions)
        .where(
          and(
            eq(suggestions.organizationId, organizationId),
            eq(suggestions.changeType, "merge"),
            inArray(suggestions.status, ["pending", "edited"]),
          ),
        ),
    ]);
    const alreadyProposed = new Set(pendingMerges.map((m) => m.targetId));

    const claudeClient = getClaudeClient();
    const receivedAt = new Date();
    let sourceId: string | null = null;

    // Created lazily, on the first real finding -- most runs find nothing,
    // and there's no reason to leave a source row behind for that.
    async function ensureSource(): Promise<string> {
      if (sourceId === null) {
        const [source] = await db
          .insert(sources)
          .values({
            organizationId,
            type: "manual",
            externalId: randomUUID(),
            receivedAt,
            rawBody: `Automated duplicate check across ${projectRows.length} project(s) and ${decisionRows.length} open decision(s).`,
          })
          .returning();
        sourceId = source.id;
      }
      return sourceId;
    }

    async function proposeMerge(targetType: "task" | "decision", duplicateId: string, keepId: string, reasoning: string, confidence: number) {
      await mergeOrInsertSuggestion(db, {
        organizationId,
        sourceId: await ensureSource(),
        sourceReceivedAt: receivedAt,
        draft: {
          changeType: "merge",
          targetType,
          targetId: duplicateId,
          proposedDiff: { supersededById: keepId },
          reasoning,
          confidence,
        },
      });
      alreadyProposed.add(duplicateId);
    }

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

      for (const pair of await findDuplicateTasks(taskRows, claudeClient)) {
        if (alreadyProposed.has(pair.supersedeTaskId)) continue;
        await proposeMerge("task", pair.supersedeTaskId, pair.keepTaskId, pair.reasoning, pair.confidence);
        duplicatesFound++;
      }
    }

    if (decisionRows.length >= 2) {
      decisionsChecked = decisionRows.length;
      for (const pair of await findDuplicateDecisions(decisionRows, claudeClient)) {
        if (alreadyProposed.has(pair.supersedeDecisionId)) continue;
        await proposeMerge("decision", pair.supersedeDecisionId, pair.keepDecisionId, pair.reasoning, pair.confidence);
        decisionDuplicatesFound++;
      }
    }

    reply.send({ projectsChecked, tasksChecked, duplicatesFound, decisionsChecked, decisionDuplicatesFound });
  });
}
