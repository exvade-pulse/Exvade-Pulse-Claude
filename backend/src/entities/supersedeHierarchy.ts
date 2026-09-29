import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { auditLog, initiatives, objectives, projects, tasks } from "../db/schema.js";
import { SupersedeError } from "../tasks/supersede.js";

export type HierarchyLevel = "objective" | "initiative" | "project";

const TABLE = { objective: objectives, initiative: initiatives, project: projects } as const;

// Children move with a merge, so nothing is orphaned under the duplicate.
const CHILDREN = {
  objective: { table: initiatives, parent: initiatives.objectiveId, key: "objectiveId", noun: "initiative" },
  initiative: { table: projects, parent: projects.initiativeId, key: "initiativeId", noun: "project" },
  project: { table: tasks, parent: tasks.projectId, key: "projectId", noun: "task" },
} as const;

// Merges a duplicate objective, initiative or project into the one being
// kept, deleting nothing: every child (open or closed, so its history
// follows) moves under the kept record, the duplicate is marked superseded
// and points at it, and anything it said that the kept record didn't -- its
// description, an owner -- is carried over. Same posture as supersedeTask.
export async function supersedeHierarchy(
  db: DbOrTx,
  params: { level: HierarchyLevel; organizationId: string; id: string; supersededById: string; actorId: string },
) {
  const { level } = params;
  if (params.id === params.supersededById) {
    throw new SupersedeError(`A ${level} can't supersede itself`);
  }
  // One table per call; the three share the columns used here.
  const table = TABLE[level] as typeof projects;
  const rows = await db
    .select({ id: table.id, title: table.title, description: table.description, owner: table.owner, status: table.status })
    .from(table)
    .where(and(eq(table.organizationId, params.organizationId), inArray(table.id, [params.id, params.supersededById])));
  const duplicate = rows.find((r) => r.id === params.id);
  const keep = rows.find((r) => r.id === params.supersededById);
  if (!duplicate || !keep) throw new SupersedeError(`${level[0].toUpperCase()}${level.slice(1)} not found`);
  if (duplicate.status === "superseded") throw new SupersedeError(`The duplicate ${level} is already merged`);
  if (keep.status === "superseded") throw new SupersedeError(`The ${level} to keep has itself been merged into another`);

  const child = CHILDREN[level];
  const childTable = child.table as typeof tasks;
  const childParent = child.parent as typeof tasks.projectId;
  const moved = await db
    .update(childTable)
    .set({ [child.key]: keep.id, updatedAt: new Date() } as never)
    .where(and(eq(childTable.organizationId, params.organizationId), eq(childParent, duplicate.id)))
    .returning({ id: childTable.id });

  const today = new Date().toISOString().slice(0, 10);
  const carried = duplicate.description && !(keep.description ?? "").includes(duplicate.description) ? ` ${duplicate.description}` : "";
  const mergeEntry = `[${today} — merged from duplicate "${duplicate.title}"]${carried}`;
  const keepPatch: Record<string, unknown> = {
    description: keep.description ? `${keep.description}\n\n${mergeEntry}` : mergeEntry,
    updatedAt: new Date(),
  };
  if (!keep.owner && duplicate.owner) keepPatch.owner = duplicate.owner;
  await db.update(table).set(keepPatch as never).where(eq(table.id, keep.id));
  await db
    .update(table)
    .set({ status: "superseded", supersededById: keep.id, updatedAt: new Date() } as never)
    .where(eq(table.id, duplicate.id));

  await db.insert(auditLog).values([
    {
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: `${level}.superseded`,
      entityType: level,
      entityId: duplicate.id,
      details: { supersededById: keep.id, previousStatus: duplicate.status, movedChildren: moved.length },
    },
    {
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: `${level}.merged_into`,
      entityType: level,
      entityId: keep.id,
      details: { duplicateId: duplicate.id, duplicateTitle: duplicate.title, movedChildren: moved.length, childType: child.noun },
    },
  ]);

  return { keptId: keep.id, movedChildren: moved.length };
}
