import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { sources, suggestions } from "../db/schema.js";

// "Updated" in the UI should mean "the real-world date of the evidence
// behind this row's current fields," not "when this database row was last
// written to." Those two dates can be wildly different -- a 2020 status
// meeting transcript imported today makes the row's own updatedAt say
// "today," which reads as urgent even though the underlying information is
// years old (the design doc's "separate source date from ingestion date"
// principle, applied to the Company Map/detail pages rather than just the
// review queue). This resolves the real date instead: the latest
// sources.receivedAt among every APPROVED suggestion that has ever targeted
// this row. Batched per targetType (one query for however many ids are on
// screen), not per-row, matching this codebase's existing batch-resolver
// pattern (see suggestions.ts's loadBreadcrumbs/loadCurrentStates).
export async function loadRealUpdatedAt(
  db: DbOrTx,
  organizationId: string,
  targetType: "objective" | "initiative" | "project" | "task" | "decision",
  targetIds: string[],
): Promise<Map<string, Date>> {
  if (targetIds.length === 0) return new Map();

  const rows = await db
    .select({ targetId: suggestions.targetId, receivedAt: sources.receivedAt })
    .from(suggestions)
    .innerJoin(sources, eq(sources.id, suggestions.sourceId))
    .where(
      and(
        eq(suggestions.organizationId, organizationId),
        eq(suggestions.targetType, targetType),
        eq(suggestions.status, "approved"),
        inArray(suggestions.targetId, targetIds),
      ),
    );

  const result = new Map<string, Date>();
  for (const row of rows) {
    if (!row.targetId) continue;
    const existing = result.get(row.targetId);
    if (!existing || row.receivedAt > existing) {
      result.set(row.targetId, row.receivedAt);
    }
  }
  return result;
}

// A row with no approved-suggestion history at all (hand-created, or
// predates suggestions existing for this org) has no real evidence date to
// fall back on -- its own updatedAt (when it was actually created/edited)
// is the most honest answer left, not a fabricated one.
export function resolveRealUpdatedAt(fallbackUpdatedAt: Date, resolved: Date | undefined): Date {
  return resolved ?? fallbackUpdatedAt;
}
