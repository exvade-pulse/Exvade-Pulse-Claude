import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import {
  decisions,
  LIVE_DECISION_STATUSES,
  projects,
  sources,
  suggestions,
  tasks,
  TERMINAL_TASK_STATUSES,
} from "../db/schema.js";
import { getContextualClaudeClient } from "../context/companyContext.js";
import {
  findContradictions,
  type CheckedRecord,
  type CheckedRecordType,
  type Contradiction,
} from "../interpretation/contradictionDetection.js";
import { AI_CONCURRENCY, mapLimited } from "../interpretation/concurrency.js";

const HISTORY_PER_RECORD = 5;

export interface ContradictionDetail {
  kind: "contradiction";
  field: string;
  olderStatement: string;
  olderDate: string | null;
  newerStatement: string;
  newerDate: string | null;
}

function historyText(diff: Record<string, unknown>): string {
  return Object.entries(diff)
    .filter(([key, value]) => !key.endsWith("Id") && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("; ");
}

// The newest approved updates for each record, with the date of the source
// they came from -- the "newer evidence" a still-recorded older statement
// may contradict.
async function loadHistory(organizationId: string, targetType: CheckedRecordType, ids: string[]) {
  const byId = new Map<string, Array<{ date: string; text: string }>>();
  if (ids.length === 0) return byId;
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
      ),
    )
    .orderBy(desc(sources.receivedAt));
  for (const row of rows) {
    const list = byId.get(row.targetId!) ?? [];
    if (list.length >= HISTORY_PER_RECORD) continue;
    const text = historyText(row.proposedDiff as Record<string, unknown>);
    if (text) list.push({ date: row.receivedAt.toISOString(), text });
    byId.set(row.targetId!, list);
  }
  return byId;
}

export async function contradictionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // On-demand (never automatic): one Claude call per project's live tasks
  // and one for the org's live decisions, looking for newer information
  // that contradicts an older statement still recorded as current. Each
  // finding becomes a "contradiction" suggestion -- a proposed correction
  // with the older and newer statements attached -- so nothing is rewritten
  // until a person approves it. A record+field already waiting on a
  // contradiction isn't re-flagged.
  app.post("/api/reviews/check-contradictions", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const claudeClient = await getContextualClaudeClient(db, organizationId);

    const [projectRows, decisionRows, pendingRows] = await Promise.all([
      db.select({ id: projects.id, title: projects.title }).from(projects).where(eq(projects.organizationId, organizationId)),
      db
        .select()
        .from(decisions)
        .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, LIVE_DECISION_STATUSES))),
      db
        .select({ targetType: suggestions.targetType, targetId: suggestions.targetId, proposedDiff: suggestions.proposedDiff })
        .from(suggestions)
        .where(
          and(
            eq(suggestions.organizationId, organizationId),
            eq(suggestions.changeType, "contradiction"),
            inArray(suggestions.status, ["pending", "edited"]),
          ),
        ),
    ]);
    const alreadyFlagged = new Set(
      pendingRows.flatMap((p) => Object.keys(p.proposedDiff as Record<string, unknown>).map((field) => `${p.targetType}:${p.targetId}:${field}`)),
    );

    let recordsChecked = 0;
    // Each group is one AI call; groups run several at a time and results
    // are combined in the original order.
    const groups: Array<{ records: CheckedRecord[]; scope: string }> = [];

    for (const project of projectRows) {
      const taskRows = await db
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.organizationId, organizationId), eq(tasks.projectId, project.id), notInArray(tasks.status, TERMINAL_TASK_STATUSES)),
        );
      if (taskRows.length === 0) continue;
      const history = await loadHistory(organizationId, "task", taskRows.map((t) => t.id));
      const records: CheckedRecord[] = taskRows.map((t) => {
        const evidence = (t.fieldEvidence ?? {}) as Record<string, { asOf?: string }>;
        const statements = (["description", "status", "latestUpdate", "nextAction", "owner"] as const)
          .filter((field) => t[field])
          .map((field) => ({ field, value: String(t[field]), asOf: evidence[field]?.asOf ?? null }));
        return { type: "task", id: t.id, title: t.title, statements, history: history.get(t.id) ?? [] };
      });
      recordsChecked += records.length;
      groups.push({ records, scope: `under the project "${project.title}"` });
    }

    if (decisionRows.length > 0) {
      const history = await loadHistory(organizationId, "decision", decisionRows.map((d) => d.id));
      const records: CheckedRecord[] = decisionRows.map((d) => ({
        type: "decision",
        id: d.id,
        title: d.title,
        statements: (["whyItMatters", "relevantContext", "suggestedNextStep"] as const)
          .filter((field) => d[field])
          .map((field) => ({ field, value: String(d[field]), asOf: null })),
        history: history.get(d.id) ?? [],
      }));
      recordsChecked += records.length;
      groups.push({ records, scope: "as open company decisions" });
    }
    const found: Contradiction[] = (await mapLimited(groups, AI_CONCURRENCY, (g) => findContradictions(g.records, g.scope, claudeClient))).flat();

    const fresh = found.filter((c) => !alreadyFlagged.has(`${c.recordType}:${c.recordId}:${c.field}`));
    if (fresh.length > 0) {
      const [source] = await db
        .insert(sources)
        .values({
          organizationId,
          type: "manual",
          externalId: randomUUID(),
          receivedAt: new Date(),
          rawBody: `Automated contradiction check across ${recordsChecked} record(s).`,
        })
        .returning();
      await db.insert(suggestions).values(
        fresh.map((c) => ({
          organizationId,
          sourceId: source.id,
          targetType: c.recordType,
          targetId: c.recordId,
          changeType: "contradiction" as const,
          proposedDiff: { [c.field]: c.correctedValue },
          reasoning: c.reasoning,
          confidence: c.confidence,
          conflicts: [
            {
              kind: "contradiction",
              field: c.field,
              olderStatement: c.olderStatement,
              olderDate: c.olderDate,
              newerStatement: c.newerStatement,
              newerDate: c.newerDate,
            } satisfies ContradictionDetail,
          ],
        })),
      );
    }

    reply.send({ recordsChecked, contradictionsFound: fresh.length });
  });
}
