import { and, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { decisions, sources, suggestions, UNDECIDED_DECISION_STATUSES } from "../db/schema.js";

const DEADLINE_SOURCE_EXTERNAL_ID = "automatic-deadline-check";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// One stable source row per org for these generated items (sources.
// externalId is unique per org), so repeated syncs don't pile up sources.
async function deadlineSourceId(db: Database, organizationId: string): Promise<string> {
  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.organizationId, organizationId), eq(sources.externalId, DEADLINE_SOURCE_EXTERNAL_ID)));
  if (existing) return existing.id;
  const [created] = await db
    .insert(sources)
    .values({
      organizationId,
      type: "manual",
      externalId: DEADLINE_SOURCE_EXTERNAL_ID,
      receivedAt: new Date(),
      rawBody: "Automatic check: open decisions whose due date has passed.",
    })
    .onConflictDoNothing()
    .returning({ id: sources.id });
  if (created) return created.id;
  // Lost a race with a concurrent sync -- the other one created it.
  const [again] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.organizationId, organizationId), eq(sources.externalId, DEADLINE_SOURCE_EXTERNAL_ID)));
  return again.id;
}

// Keeps "Deadline passed: what actually happened?" review items in step
// with reality, with no model call: one pending item per undecided decision
// whose due date is behind us, and any pending item whose decision has
// since been decided, closed or given a future due date is resolved
// (marked approved with no reviewer -- the question was answered
// elsewhere). Idempotent; safe to call on every page load.
export async function syncDeadlineItems(db: Database, organizationId: string, now = new Date()) {
  const [overdue, pending] = await Promise.all([
    db
      .select({ id: decisions.id, title: decisions.title, status: decisions.status, dueDate: decisions.dueDate })
      .from(decisions)
      .where(
        and(
          eq(decisions.organizationId, organizationId),
          inArray(decisions.status, UNDECIDED_DECISION_STATUSES),
          lt(decisions.dueDate, now),
        ),
      ),
    db
      .select({ id: suggestions.id, targetId: suggestions.targetId })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.changeType, "deadline_passed"),
          inArray(suggestions.status, ["pending", "edited"]),
        ),
      ),
  ]);

  const overdueIds = new Set(overdue.map((d) => d.id));
  const answered = pending.filter((p) => !p.targetId || !overdueIds.has(p.targetId)).map((p) => p.id);
  if (answered.length > 0) {
    await db
      .update(suggestions)
      .set({ status: "approved", reviewedAt: now })
      .where(and(eq(suggestions.organizationId, organizationId), inArray(suggestions.id, answered)));
  }

  const alreadyAsked = new Set(pending.map((p) => p.targetId));
  const toAsk = overdue.filter((d) => !alreadyAsked.has(d.id));
  if (toAsk.length === 0) return { created: 0, resolved: answered.length };

  const sourceId = await deadlineSourceId(db, organizationId);
  await db.insert(suggestions).values(
    toAsk.map((d) => ({
      organizationId,
      sourceId,
      targetType: "decision" as const,
      targetId: d.id,
      changeType: "deadline_passed" as const,
      // Pre-filled so "Edit" can set a new due date and Approve applies it.
      proposedDiff: { dueDate: d.dueDate!.toISOString() },
      reasoning: `Was due ${formatDate(d.dueDate!)} and is still marked ${d.status === "pending_info" ? "waiting on information" : "open"}. What actually happened? Record the decision or close it on the Decisions page, or set a new due date here.`,
      confidence: 1,
    })),
  );
  return { created: toAsk.length, resolved: answered.length };
}
