import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { decisions, initiatives, LIVE_DECISION_STATUSES, objectives, projects, sources, suggestions, tasks, TERMINAL_TASK_STATUSES } from "../db/schema.js";
import { findDuplicateDecisions, findDuplicateHierarchy, findDuplicateTasks, type DuplicateCandidateHierarchy, type DuplicateCandidateTask } from "../interpretation/duplicateDetection.js";
import { AI_CONCURRENCY, mapLimited } from "../interpretation/concurrency.js";
import { getContextualClaudeClient } from "../context/companyContext.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";

// A finished task is already a closed matter, so there's nothing useful in
// flagging it (or comparing other tasks against it) as a duplicate.
const DUPLICATE_CHECK_EXCLUDED_STATUSES = TERMINAL_TASK_STATUSES;

const LIVE_STRATEGY_STATUSES = ["active", "paused"] as const;

function countLabel(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Live (active or paused) objectives, initiatives and projects, each with
// where it sits and how much is filed under it.
async function loadHierarchyCandidates(organizationId: string): Promise<Record<"objective" | "initiative" | "project", DuplicateCandidateHierarchy[]>> {
  const [objectiveRows, initiativeRows, projectRows, taskRows] = await Promise.all([
    db
      .select({ id: objectives.id, title: objectives.title, description: objectives.description, status: objectives.status })
      .from(objectives)
      .where(and(eq(objectives.organizationId, organizationId), inArray(objectives.status, [...LIVE_STRATEGY_STATUSES]))),
    db
      .select({ id: initiatives.id, objectiveId: initiatives.objectiveId, title: initiatives.title, description: initiatives.description, status: initiatives.status })
      .from(initiatives)
      .where(and(eq(initiatives.organizationId, organizationId), inArray(initiatives.status, [...LIVE_STRATEGY_STATUSES]))),
    db
      .select({ id: projects.id, initiativeId: projects.initiativeId, title: projects.title, description: projects.description, status: projects.status })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), inArray(projects.status, [...LIVE_STRATEGY_STATUSES]))),
    db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.organizationId, organizationId)),
  ]);
  const tally = <T,>(rows: T[], key: (row: T) => string) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
    return counts;
  };
  const initiativesPer = tally(initiativeRows, (r) => r.objectiveId);
  const projectsPer = tally(projectRows, (r) => r.initiativeId);
  const tasksPer = tally(taskRows, (r) => r.projectId);
  const objectiveTitle = new Map(objectiveRows.map((o) => [o.id, o.title]));
  const initiativeTitle = new Map(initiativeRows.map((i) => [i.id, i.title]));

  return {
    objective: objectiveRows.map((o) => ({ ...o, parent: null, contents: countLabel(initiativesPer.get(o.id) ?? 0, "initiative") })),
    initiative: initiativeRows.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      status: i.status,
      parent: objectiveTitle.has(i.objectiveId) ? `under objective: ${objectiveTitle.get(i.objectiveId)}` : null,
      contents: countLabel(projectsPer.get(i.id) ?? 0, "project"),
    })),
    project: projectRows.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      status: p.status,
      parent: initiativeTitle.has(p.initiativeId) ? `under initiative: ${initiativeTitle.get(p.initiativeId)}` : null,
      contents: countLabel(tasksPer.get(p.id) ?? 0, "task"),
    })),
  };
}

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

    const claudeClient = await getContextualClaudeClient(db, organizationId);
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

    async function proposeMerge(targetType: "task" | "decision" | "objective" | "initiative" | "project", duplicateId: string, keepId: string, reasoning: string, confidence: number) {
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

    // Gather every list to compare first, then run the AI comparisons
    // several at a time, then record the findings in the original order --
    // the same outcome as one-by-one, just without waiting on each call.
    const projectTaskLists: DuplicateCandidateTask[][] = [];
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
      projectTaskLists.push(taskRows);
    }

    // Objectives, initiatives and projects, each level company-wide.
    // Approving a merge moves everything under the duplicate to the record
    // kept (see supersedeHierarchy).
    const hierarchy = await loadHierarchyCandidates(organizationId);
    let hierarchyChecked = 0;
    let hierarchyDuplicatesFound = 0;
    const hierarchyLists = (["objective", "initiative", "project"] as const)
      .map((level) => ({ level, items: hierarchy[level].filter((item) => !alreadyProposed.has(item.id)) }))
      .filter(({ items }) => items.length >= 2);
    for (const { items } of hierarchyLists) hierarchyChecked += items.length;
    if (decisionRows.length >= 2) decisionsChecked = decisionRows.length;

    type Job =
      | { kind: "task"; items: DuplicateCandidateTask[] }
      | { kind: "decision" }
      | { kind: "hierarchy"; level: "objective" | "initiative" | "project"; items: DuplicateCandidateHierarchy[] };
    const jobs: Job[] = [
      ...projectTaskLists.map((items) => ({ kind: "task" as const, items })),
      ...(decisionRows.length >= 2 ? [{ kind: "decision" as const }] : []),
      ...hierarchyLists.map(({ level, items }) => ({ kind: "hierarchy" as const, level, items })),
    ];
    const results = await mapLimited(jobs, AI_CONCURRENCY, async (job) => {
      if (job.kind === "task") {
        return (await findDuplicateTasks(job.items, claudeClient)).map((p) => ({ type: "task" as const, dup: p.supersedeTaskId, keep: p.keepTaskId, reasoning: p.reasoning, confidence: p.confidence }));
      }
      if (job.kind === "decision") {
        return (await findDuplicateDecisions(decisionRows, claudeClient)).map((p) => ({ type: "decision" as const, dup: p.supersedeDecisionId, keep: p.keepDecisionId, reasoning: p.reasoning, confidence: p.confidence }));
      }
      return (await findDuplicateHierarchy(job.level, job.items, claudeClient)).map((p) => ({ type: job.level, dup: p.supersedeId, keep: p.keepId, reasoning: p.reasoning, confidence: p.confidence }));
    });

    for (const pair of results.flat()) {
      if (alreadyProposed.has(pair.dup)) continue;
      await proposeMerge(pair.type, pair.dup, pair.keep, pair.reasoning, pair.confidence);
      if (pair.type === "task") duplicatesFound++;
      else if (pair.type === "decision") decisionDuplicatesFound++;
      else hierarchyDuplicatesFound++;
    }

    reply.send({ projectsChecked, tasksChecked, duplicatesFound, decisionsChecked, decisionDuplicatesFound, hierarchyChecked, hierarchyDuplicatesFound });
  });
}
