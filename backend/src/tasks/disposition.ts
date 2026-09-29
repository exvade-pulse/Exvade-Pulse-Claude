import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, tasks, TERMINAL_TASK_STATUSES } from "../db/schema.js";

export class TaskDispositionError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "conflict",
  ) {
    super(message);
  }
}

export type TaskDisposition = "completed" | "cancelled" | "active";

const LABEL: Record<TaskDisposition, string> = {
  completed: "Marked done",
  cancelled: "Marked not relevant anymore",
  active: "Reopened",
};

// A person closing out (or reopening) a task directly -- the one change to
// a task that doesn't go through the review queue, because it *is* the
// human decision. Nothing is deleted: a cancelled task leaves every list
// and report but keeps its history. The status is stamped as confirmed
// now in fieldEvidence, so an older source arriving later can't quietly
// flip it back -- the conflict engine (see suggestions/dedupe.ts) holds
// that back for review instead.
export async function setTaskDisposition(
  db: Database,
  params: { organizationId: string; taskId: string; actorId: string; status: TaskDisposition; note?: string | null },
) {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, params.taskId), eq(tasks.organizationId, params.organizationId)));
    if (!task) throw new TaskDispositionError("Task not found", "not_found");

    const isClosed = TERMINAL_TASK_STATUSES.includes(task.status);
    if (params.status === "active") {
      if (task.status !== "completed" && task.status !== "cancelled") {
        throw new TaskDispositionError(
          task.status === "superseded" ? "A merged (superseded) task can't be reopened" : "Only a done or cancelled task can be reopened",
          "conflict",
        );
      }
    } else if (isClosed) {
      throw new TaskDispositionError(`Task is already ${task.status}`, "conflict");
    }

    const now = new Date();
    const note = params.note?.trim() || null;
    const evidence: Record<string, { asOf: string; sourceId: null }> = { status: { asOf: now.toISOString(), sourceId: null } };
    const set: Record<string, unknown> = { status: params.status, updatedAt: now };
    if (note) {
      set.latestUpdate = `${LABEL[params.status]}: ${note}`;
      evidence.latestUpdate = { asOf: now.toISOString(), sourceId: null };
    }
    set.fieldEvidence = sql`COALESCE(${tasks.fieldEvidence}, '{}'::jsonb) || ${JSON.stringify(evidence)}::jsonb`;

    const [updated] = await tx.update(tasks).set(set as never).where(eq(tasks.id, task.id)).returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "task.status_set_manually",
      entityType: "task",
      entityId: task.id,
      details: { from: task.status, to: params.status, note },
    });

    return updated;
  });
}
