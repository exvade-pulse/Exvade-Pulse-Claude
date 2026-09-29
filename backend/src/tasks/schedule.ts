import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, tasks } from "../db/schema.js";
import { normalizeTaskDates } from "../suggestions/apply.js";

export interface TaskScheduleFields {
  dueDate?: string | null;
  dueDateType?: string | null;
  dueLabel?: string | null;
  waitingFor?: string | null;
  followUpOn?: string | null;
}

// A person setting a task's date or what it's waiting on directly -- like
// marking it done, this *is* the human decision, so it doesn't go through
// Review. The fields are stamped as confirmed now in fieldEvidence, so an
// older source arriving later can't quietly undo them.
export async function setTaskSchedule(
  db: Database,
  params: { organizationId: string; taskId: string; actorId: string; fields: TaskScheduleFields },
) {
  const fields: Record<string, unknown> = {};
  for (const key of ["dueDate", "dueDateType", "dueLabel", "waitingFor", "followUpOn"] as const) {
    if (!(key in params.fields)) continue;
    const value = params.fields[key];
    fields[key] = typeof value === "string" ? value.trim() || null : null;
  }
  normalizeTaskDates(fields);
  if (fields.dueDate === null) {
    fields.dueDateType = null;
    fields.dueLabel = null;
  }
  if (Object.keys(fields).length === 0) return null;

  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const evidence: Record<string, { asOf: string; sourceId: null }> = {};
    if ("dueDate" in fields) evidence.dueDate = { asOf: now, sourceId: null };
    if ("waitingFor" in fields) evidence.waitingFor = { asOf: now, sourceId: null };
    const [task] = await tx
      .update(tasks)
      .set({
        ...fields,
        updatedAt: new Date(),
        ...(Object.keys(evidence).length ? { fieldEvidence: sql`COALESCE(${tasks.fieldEvidence}, '{}'::jsonb) || ${JSON.stringify(evidence)}::jsonb` } : {}),
      } as never)
      .where(and(eq(tasks.id, params.taskId), eq(tasks.organizationId, params.organizationId)))
      .returning();
    if (!task) return null;
    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "task.schedule_updated",
      entityType: "task",
      entityId: task.id,
      details: { fields: Object.keys(fields) },
    });
    return task;
  });
}
