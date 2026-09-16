import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { decisions } from "../db/schema.js";

export interface BlockingDecisionRef {
  id: string;
  title: string;
}

// Batch lookup, not N+1 per task: every open decision in the org whose
// relatedTaskId points at one of these tasks, in one query. Shared by
// dashboard.ts's needs-attention endpoint and companyMap.ts's tree, which
// both need the same "why is this task stuck" signal on a set of tasks
// rather than one task's full detail (see companyMap.ts's GET /api/tasks/:id
// for the single-task version of this same lookup).
export async function blockingDecisionsForTasks(
  db: DbOrTx,
  organizationId: string,
  taskIds: string[],
): Promise<Map<string, BlockingDecisionRef>> {
  if (taskIds.length === 0) return new Map();

  const rows = await db
    .select({ id: decisions.id, title: decisions.title, relatedTaskId: decisions.relatedTaskId })
    .from(decisions)
    .where(
      and(
        eq(decisions.organizationId, organizationId),
        eq(decisions.status, "open"),
        inArray(decisions.relatedTaskId, taskIds),
      ),
    );

  return new Map(rows.map((row) => [row.relatedTaskId as string, { id: row.id, title: row.title }]));
}
