import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { auditLog, tasks, TERMINAL_TASK_STATUSES } from "../db/schema.js";

export class SupersedeError extends Error {}

// Merges a duplicate task into the one being kept, deleting nothing: the
// duplicate is marked superseded and points at the kept task, with its own
// fields left exactly as they were (its history stays readable), and
// whatever it knew that the kept task didn't -- its description and latest
// update, a next action, an owner -- is carried over to the kept task.
export async function supersedeTask(
  db: DbOrTx,
  params: { organizationId: string; taskId: string; supersededById: string; actorId: string },
) {
  if (params.taskId === params.supersededById) {
    throw new SupersedeError("A task can't supersede itself");
  }
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.organizationId, params.organizationId), inArray(tasks.id, [params.taskId, params.supersededById])));
  const duplicate = rows.find((t) => t.id === params.taskId);
  const keep = rows.find((t) => t.id === params.supersededById);
  if (!duplicate || !keep) {
    throw new SupersedeError("Task not found");
  }
  if (TERMINAL_TASK_STATUSES.includes(duplicate.status)) {
    throw new SupersedeError(`The duplicate is already ${duplicate.status}`);
  }
  if (keep.status === "superseded") {
    throw new SupersedeError("The task to keep has itself been superseded");
  }

  const today = new Date().toISOString().slice(0, 10);
  const carried = [duplicate.description, duplicate.latestUpdate]
    .filter((text): text is string => !!text && !(keep.description ?? "").includes(text) && text !== keep.latestUpdate)
    .join("\n");
  const mergeEntry = `[${today} — merged from duplicate "${duplicate.title}"]${carried ? ` ${carried}` : ""}`;
  const keepPatch: Partial<typeof tasks.$inferInsert> = {
    description: keep.description ? `${keep.description}\n\n${mergeEntry}` : mergeEntry,
    updatedAt: new Date(),
  };
  if (!keep.nextAction && duplicate.nextAction) keepPatch.nextAction = duplicate.nextAction;
  if (!keep.owner && duplicate.owner) keepPatch.owner = duplicate.owner;

  const [kept] = await db.update(tasks).set(keepPatch).where(eq(tasks.id, keep.id)).returning();
  const [superseded] = await db
    .update(tasks)
    .set({ status: "superseded", supersededById: keep.id, updatedAt: new Date() })
    .where(eq(tasks.id, duplicate.id))
    .returning();

  await db.insert(auditLog).values([
    {
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "task.superseded",
      entityType: "task",
      entityId: duplicate.id,
      details: { supersededById: keep.id, previousStatus: duplicate.status },
    },
    {
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "task.merged_into",
      entityType: "task",
      entityId: keep.id,
      details: { duplicateId: duplicate.id, duplicateTitle: duplicate.title },
    },
  ]);

  return { kept, superseded };
}
