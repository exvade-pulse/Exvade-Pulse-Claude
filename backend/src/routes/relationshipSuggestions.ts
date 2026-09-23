import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { entityRelationships, decisions, projects, sources, suggestions, tasks } from "../db/schema.js";
import { findRelationships, type RelationshipCandidate } from "../interpretation/relationshipDetection.js";
import { getClaudeClient } from "../interpretation/claudeClient.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";

// Same reasoning as duplicates.ts: a closed task carries nothing left to
// depend on or be blocked by, so there's no point flagging it (or matching
// other tasks against it) as one end of a new relationship.
const RELATIONSHIP_CHECK_EXCLUDED_TASK_STATUSES: Array<"completed" | "resolved" | "superseded"> = [
  "completed",
  "resolved",
  "superseded",
];

function relationshipKey(fromType: string, fromId: string, toType: string, toId: string): string {
  return `${fromType}:${fromId}:${toType}:${toId}`;
}

export async function relationshipSuggestionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // On-demand (never automatic): checks every project with two or more
  // eligible tasks, plus the org's open decisions, for genuine relationships
  // -- one Claude call per project (task<->task within it, task<->decision
  // org-wide), not one per candidate pair, so cost scales with project count
  // rather than candidate count squared. A found relationship proposes
  // creating a real entity_relationships row as an ordinary suggestion in
  // the normal review queue, rather than writing one itself.
  app.post("/api/relationships/suggest", async (request, reply) => {
    const organizationId = request.user!.organizationId;

    const projectRows = await db.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, organizationId));

    let projectsChecked = 0;
    let tasksChecked = 0;
    let relationshipsFound = 0;

    const decisionRows = await db
      .select({ id: decisions.id, title: decisions.title, whyItMatters: decisions.whyItMatters, status: decisions.status })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), eq(decisions.status, "open")));

    const decisionCandidates: RelationshipCandidate[] = decisionRows.map((d) => ({
      type: "decision",
      id: d.id,
      title: d.title,
      detail: d.whyItMatters,
      status: d.status,
    }));

    if (projectRows.length === 0) {
      reply.send({ projectsChecked, tasksChecked, relationshipsFound });
      return;
    }

    // Existing real relationships, plus anything already proposed and not
    // yet resolved -- both directly prevent re-proposing the exact same
    // pair on every single run. Loaded once, org-wide: mergeOrInsertSuggestion
    // never merges relationship suggestions into each other (targetId is
    // always null for this targetType), so without this check the same
    // genuine pair would otherwise pile up a fresh suggestion every time
    // this endpoint is called.
    const existingRelationshipRows = await db
      .select({ fromType: entityRelationships.fromType, fromId: entityRelationships.fromId, toType: entityRelationships.toType, toId: entityRelationships.toId })
      .from(entityRelationships)
      .where(eq(entityRelationships.organizationId, organizationId));

    const pendingRelationshipSuggestionRows = await db
      .select({ proposedDiff: suggestions.proposedDiff })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, "relationship"),
          inArray(suggestions.status, ["pending", "edited"]),
        ),
      );

    const existingKeys = new Set<string>();
    for (const r of existingRelationshipRows) {
      existingKeys.add(relationshipKey(r.fromType, r.fromId, r.toType, r.toId));
    }
    for (const s of pendingRelationshipSuggestionRows) {
      const diff = s.proposedDiff as { fromType?: string; fromId?: string; toType?: string; toId?: string };
      if (diff.fromType && diff.fromId && diff.toType && diff.toId) {
        existingKeys.add(relationshipKey(diff.fromType, diff.fromId, diff.toType, diff.toId));
      }
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
          status: tasks.status,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, project.id),
            eq(tasks.organizationId, organizationId),
            notInArray(tasks.status, RELATIONSHIP_CHECK_EXCLUDED_TASK_STATUSES),
          ),
        );

      if (taskRows.length < 2) continue;
      projectsChecked++;
      tasksChecked += taskRows.length;

      const taskCandidates: RelationshipCandidate[] = taskRows.map((t) => ({
        type: "task",
        id: t.id,
        title: t.title,
        detail: t.description,
        status: t.status,
      }));
      const candidates = [...taskCandidates, ...decisionCandidates];

      const proposals = await findRelationships(candidates, existingKeys, claudeClient);
      if (proposals.length === 0) continue;

      // Created lazily, on the first real finding -- see duplicates.ts for
      // the same reasoning: most runs across most orgs find nothing, and
      // there's no reason to leave a source row behind for a check that
      // turned up empty.
      if (sourceId === null) {
        const [source] = await db
          .insert(sources)
          .values({
            organizationId,
            type: "manual",
            externalId: randomUUID(),
            receivedAt,
            rawBody: `Automated relationship check across ${projectRows.length} project(s).`,
          })
          .returning();
        sourceId = source.id;
      }

      for (const proposal of proposals) {
        await mergeOrInsertSuggestion(db, {
          organizationId,
          sourceId,
          sourceReceivedAt: receivedAt,
          draft: {
            changeType: "relationship",
            targetType: "relationship",
            targetId: null,
            proposedDiff: {
              fromType: proposal.fromType,
              fromId: proposal.fromId,
              toType: proposal.toType,
              toId: proposal.toId,
              relationType: proposal.relationType,
              ...(proposal.note ? { note: proposal.note } : {}),
            },
            reasoning: proposal.reasoning,
            confidence: proposal.confidence,
          },
        });
        // Prevents this same pair from being proposed again by a later
        // project in this same run (a decision can be a candidate against
        // more than one project's tasks).
        existingKeys.add(relationshipKey(proposal.fromType, proposal.fromId, proposal.toType, proposal.toId));
        relationshipsFound++;
      }
    }

    reply.send({ projectsChecked, tasksChecked, relationshipsFound });
  });
}
