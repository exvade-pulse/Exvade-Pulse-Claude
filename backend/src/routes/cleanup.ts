import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { sources, STANDALONE_CHANGE_TYPES, suggestions } from "../db/schema.js";
import { getClaudeClient } from "../interpretation/claudeClient.js";
import {
  proposeCleanup,
  type CleanupAction,
  type CleanupCandidate,
  type CleanupContext,
  type CleanupProposal,
} from "../interpretation/cleanupDetection.js";
import { buildExecutiveReviewData, type ReviewTask } from "../reports/executiveReview.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const UPDATE_WINDOW_DAYS = 120;
const UPDATES_PER_BATCH = 15;

const CLASSIFICATION: Record<CleanupAction, string> = {
  close_completed: "likely_completed",
  close_abandoned: "likely_abandoned",
  supersede: "likely_superseded",
  replace: "replaced_by_new_work",
  update_next_action: "stale_next_action",
  confirm_active: "still_active",
  needs_human: "needs_confirmation",
};

function diffText(diff: Record<string, unknown>): string {
  return Object.entries(diff)
    .filter(([key, value]) => !key.endsWith("Id") && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("; ");
}

async function recentUpdatesFor(organizationId: string, targetType: "task" | "decision", ids: string[], titleOf: (id: string) => string) {
  if (ids.length === 0) return [];
  const since = new Date(Date.now() - UPDATE_WINDOW_DAYS * MS_PER_DAY);
  const rows = await db
    .select({ targetId: suggestions.targetId, proposedDiff: suggestions.proposedDiff, receivedAt: sources.receivedAt })
    .from(suggestions)
    .innerJoin(sources, eq(sources.id, suggestions.sourceId))
    .where(
      and(
        eq(suggestions.organizationId, organizationId),
        eq(suggestions.targetType, targetType),
        inArray(suggestions.targetId, ids),
        eq(suggestions.status, "approved"),
        gte(sources.receivedAt, since),
      ),
    )
    .orderBy(desc(sources.receivedAt))
    .limit(UPDATES_PER_BATCH);
  return rows
    .map((r) => ({ date: r.receivedAt.toISOString(), record: titleOf(r.targetId!), text: diffText(r.proposedDiff as Record<string, unknown>) }))
    .filter((u) => u.text);
}

function taskCandidate(t: ReviewTask, why: CleanupCandidate["why"]): CleanupCandidate {
  return {
    type: "task",
    id: t.id,
    title: t.title,
    status: t.status,
    why,
    nextAction: t.nextAction,
    latestUpdate: t.latestUpdate,
    lastEvidence: t.lastEvidenceAt,
  };
}

// Turns one proposal into the review-queue item a person approves. Closing,
// confirming and next-action changes are "cleanup" suggestions on the
// record itself; superseding reuses the duplicate-merge flow (nothing
// deleted, the old record points at the one covering it); replacing is its
// own "replace" suggestion that, on approval, creates the new task and
// supersedes the old one in a single step.
function toSuggestion(p: CleanupProposal) {
  const detail = { kind: "cleanup", classification: CLASSIFICATION[p.action] };
  const base = { targetType: p.recordType, targetId: p.recordId, reasoning: p.reasoning, confidence: p.confidence, conflicts: [detail] };
  const nextField = p.recordType === "task" ? "nextAction" : "suggestedNextStep";
  switch (p.action) {
    case "close_completed":
      return { ...base, changeType: "cleanup" as const, proposedDiff: { status: "completed", latestUpdate: p.closingNote ?? "Closed as completed during cleanup." } };
    case "close_abandoned":
      return { ...base, changeType: "cleanup" as const, proposedDiff: { status: "cancelled", latestUpdate: p.closingNote ?? "Closed as no longer relevant during cleanup." } };
    case "supersede":
      return { ...base, changeType: "merge" as const, proposedDiff: { supersededById: p.supersededById } };
    case "replace":
      return { ...base, changeType: "replace" as const, proposedDiff: { newTask: p.replacement } };
    case "update_next_action":
      return { ...base, changeType: "cleanup" as const, proposedDiff: { [nextField]: p.newNextAction } };
    default:
      // confirm_active / needs_human: approving confirms it's still live
      // (the approval itself becomes fresh evidence); rejecting leaves it.
      return { ...base, changeType: "cleanup" as const, proposedDiff: {} };
  }
}

export async function cleanupRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // On demand: one Claude call per workstream that has stale records or
  // stale next actions, plus one for decisions with stale next steps. Each
  // record gets exactly one proposed resolution in Review; nothing is
  // applied until a person approves it. Records already waiting on a
  // merge/replace/cleanup/conflict/deadline question are skipped.
  app.post("/api/reviews/cleanup", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const data = await buildExecutiveReviewData(organizationId, "admin");

    const pending = await db
      .select({ targetId: suggestions.targetId })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          inArray(suggestions.changeType, [...STANDALONE_CHANGE_TYPES]),
          inArray(suggestions.status, ["pending", "edited"]),
        ),
      );
    const waiting = new Set(pending.map((p) => p.targetId));

    const flagged = new Map<string, CleanupCandidate>();
    for (const t of data.needsDisposition) if (!waiting.has(t.id)) flagged.set(t.id, taskCandidate(t, "stale"));
    for (const t of [...data.risks, ...data.operatingActions]) {
      if (t.nextActionStale && !waiting.has(t.id) && !flagged.has(t.id)) flagged.set(t.id, taskCandidate(t, "stale_next_action"));
    }

    const claudeClient = getClaudeClient();
    const proposals: CleanupProposal[] = [];
    let recordsChecked = 0;

    for (const group of data.inventory) {
      const candidates = group.tasks.map((t) => flagged.get(t.id)).filter((c): c is CleanupCandidate => !!c);
      if (candidates.length === 0) continue;
      const candidateIds = new Set(candidates.map((c) => c.id));
      const titleById = new Map(group.tasks.map((t) => [t.id, t.title]));
      const context: CleanupContext = {
        scope: `in the workstream "${group.project}" (objective: ${group.objective})`,
        otherTasks: group.tasks
          .filter((t) => !candidateIds.has(t.id))
          .map((t) => ({ id: t.id, title: t.title, status: t.status, nextAction: t.nextAction, lastEvidence: t.lastEvidenceAt })),
        recentUpdates: await recentUpdatesFor(organizationId, "task", group.tasks.map((t) => t.id), (id) => titleById.get(id) ?? "(task)"),
        openDecisions: data.decisionsNeeded.map((d) => ({ id: d.id, title: d.title })),
      };
      recordsChecked += candidates.length;
      proposals.push(...(await proposeCleanup(candidates, context, claudeClient)));
    }

    const staleDecisions = [...data.decisionsNeeded, ...data.deadlinePassed].filter((d) => d.nextStepStale && !waiting.has(d.id));
    if (staleDecisions.length > 0) {
      const all = [...data.decisionsNeeded, ...data.deadlinePassed, ...data.decisionsInProgress];
      const titleById = new Map(all.map((d) => [d.id, d.title]));
      const candidates: CleanupCandidate[] = staleDecisions.map((d) => ({
        type: "decision",
        id: d.id,
        title: d.title,
        status: d.status,
        why: "stale_next_action",
        nextAction: d.suggestedNextStep,
        latestUpdate: d.relevantContext,
        lastEvidence: new Date(Date.now() - (d.nextStepAgeDays ?? 0) * MS_PER_DAY).toISOString(),
      }));
      const context: CleanupContext = {
        scope: "as open company decisions",
        otherTasks: [],
        recentUpdates: await recentUpdatesFor(organizationId, "decision", all.map((d) => d.id), (id) => titleById.get(id) ?? "(decision)"),
        openDecisions: all.map((d) => ({ id: d.id, title: d.title })),
      };
      recordsChecked += candidates.length;
      proposals.push(...(await proposeCleanup(candidates, context, claudeClient)));
    }

    if (proposals.length > 0) {
      const [source] = await db
        .insert(sources)
        .values({
          organizationId,
          type: "manual",
          externalId: randomUUID(),
          receivedAt: new Date(),
          rawBody: `Automated cleanup check across ${recordsChecked} flagged record(s).`,
        })
        .returning();
      await db.insert(suggestions).values(proposals.map((p) => ({ organizationId, sourceId: source.id, ...toSuggestion(p) })));
    }

    const byAction: Partial<Record<CleanupAction, number>> = {};
    for (const p of proposals) byAction[p.action] = (byAction[p.action] ?? 0) + 1;
    reply.send({ recordsChecked, proposals: proposals.length, byAction });
  });
}
