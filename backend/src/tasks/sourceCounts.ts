import { and, count, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { suggestions } from "../db/schema.js";

// All-time count of approved suggestions citing each task -- for a
// lightweight "N sources" tag on compact task cards (Company Map, dashboard
// lists). Distinct from reports.ts's own source count, which is deliberately
// scoped to suggestions reviewed within one specific week; this one answers
// "has this task ever been backed by a real source" rather than "this week".
export async function taskSourceCounts(
  db: DbOrTx,
  organizationId: string,
  taskIds: string[],
): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();

  const rows = await db
    .select({ targetId: suggestions.targetId, count: count() })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.organizationId, organizationId),
        eq(suggestions.targetType, "task"),
        inArray(suggestions.targetId, taskIds),
        eq(suggestions.status, "approved"),
      ),
    )
    .groupBy(suggestions.targetId);

  return new Map(rows.map((row) => [row.targetId as string, row.count]));
}
