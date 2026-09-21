import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { initiatives, objectives, projects, sources, suggestions, tasks } from "../db/schema.js";

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

function mergeMax(...maps: Array<Map<string, Date>>): Map<string, Date> {
  const result = new Map<string, Date>();
  for (const map of maps) {
    for (const [id, date] of map) {
      const existing = result.get(id);
      if (!existing || date > existing) result.set(id, date);
    }
  }
  return result;
}

// Real activity almost always lands on a TASK (a status update, a next
// action, a completion) -- direct suggestions on a project/initiative/
// objective row itself are the rare "broad status roundup" case, not the
// common one. A project that's never been the direct target of a
// suggestion, but whose tasks have real history, must still surface the
// most recent (or, just as importantly, the OLDEST-and-therefore-most-stale)
// real date among its own tasks -- not silently fall back to its own
// creation timestamp as if nothing is known about it at all.
export async function loadRealUpdatedAtForProjects(
  db: DbOrTx,
  organizationId: string,
  projectIds: string[],
): Promise<Map<string, Date>> {
  if (projectIds.length === 0) return new Map();

  const [direct, viaTasks] = await Promise.all([
    loadRealUpdatedAt(db, organizationId, "project", projectIds),
    db
      .select({ projectId: tasks.projectId, receivedAt: sources.receivedAt })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .innerJoin(tasks, eq(tasks.id, suggestions.targetId))
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, "task"),
          eq(suggestions.status, "approved"),
          inArray(tasks.projectId, projectIds),
        ),
      ),
  ]);

  const viaTasksMap = new Map<string, Date>();
  for (const row of viaTasks) {
    const existing = viaTasksMap.get(row.projectId);
    if (!existing || row.receivedAt > existing) viaTasksMap.set(row.projectId, row.receivedAt);
  }

  return mergeMax(direct, viaTasksMap);
}

// Same rollup one level up: an initiative's real date is the most recent
// evidence among (a) suggestions directly on the initiative, (b) its
// projects, and (c) the tasks inside those projects.
export async function loadRealUpdatedAtForInitiatives(
  db: DbOrTx,
  organizationId: string,
  initiativeIds: string[],
): Promise<Map<string, Date>> {
  if (initiativeIds.length === 0) return new Map();

  const [direct, viaProjects, viaTasks] = await Promise.all([
    loadRealUpdatedAt(db, organizationId, "initiative", initiativeIds),
    db
      .select({ initiativeId: projects.initiativeId, receivedAt: sources.receivedAt })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .innerJoin(projects, eq(projects.id, suggestions.targetId))
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, "project"),
          eq(suggestions.status, "approved"),
          inArray(projects.initiativeId, initiativeIds),
        ),
      ),
    db
      .select({ initiativeId: projects.initiativeId, receivedAt: sources.receivedAt })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .innerJoin(tasks, eq(tasks.id, suggestions.targetId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, "task"),
          eq(suggestions.status, "approved"),
          inArray(projects.initiativeId, initiativeIds),
        ),
      ),
  ]);

  const viaProjectsMap = new Map<string, Date>();
  for (const row of viaProjects) {
    const existing = viaProjectsMap.get(row.initiativeId);
    if (!existing || row.receivedAt > existing) viaProjectsMap.set(row.initiativeId, row.receivedAt);
  }
  const viaTasksMap = new Map<string, Date>();
  for (const row of viaTasks) {
    const existing = viaTasksMap.get(row.initiativeId);
    if (!existing || row.receivedAt > existing) viaTasksMap.set(row.initiativeId, row.receivedAt);
  }

  return mergeMax(direct, viaProjectsMap, viaTasksMap);
}

// Same rollup one more level up: an objective's real date is the most
// recent evidence among itself, its initiatives, their projects, and the
// tasks inside those projects.
export async function loadRealUpdatedAtForObjectives(
  db: DbOrTx,
  organizationId: string,
  objectiveIds: string[],
): Promise<Map<string, Date>> {
  if (objectiveIds.length === 0) return new Map();

  const [direct, viaInitiatives, viaProjects, viaTasks] = await Promise.all([
    loadRealUpdatedAt(db, organizationId, "objective", objectiveIds),
    db
      .select({ objectiveId: initiatives.objectiveId, receivedAt: sources.receivedAt })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .innerJoin(initiatives, eq(initiatives.id, suggestions.targetId))
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, "initiative"),
          eq(suggestions.status, "approved"),
          inArray(initiatives.objectiveId, objectiveIds),
        ),
      ),
    db
      .select({ objectiveId: initiatives.objectiveId, receivedAt: sources.receivedAt })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .innerJoin(projects, eq(projects.id, suggestions.targetId))
      .innerJoin(initiatives, eq(initiatives.id, projects.initiativeId))
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, "project"),
          eq(suggestions.status, "approved"),
          inArray(initiatives.objectiveId, objectiveIds),
        ),
      ),
    db
      .select({ objectiveId: initiatives.objectiveId, receivedAt: sources.receivedAt })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .innerJoin(tasks, eq(tasks.id, suggestions.targetId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(initiatives, eq(initiatives.id, projects.initiativeId))
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, "task"),
          eq(suggestions.status, "approved"),
          inArray(initiatives.objectiveId, objectiveIds),
        ),
      ),
  ]);

  const toMap = (rows: Array<{ objectiveId: string; receivedAt: Date }>) => {
    const map = new Map<string, Date>();
    for (const row of rows) {
      const existing = map.get(row.objectiveId);
      if (!existing || row.receivedAt > existing) map.set(row.objectiveId, row.receivedAt);
    }
    return map;
  };

  return mergeMax(direct, toMap(viaInitiatives), toMap(viaProjects), toMap(viaTasks));
}
