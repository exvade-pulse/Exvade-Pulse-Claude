import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import {
  decisions,
  initiatives,
  objectives,
  projects,
  sources,
  suggestions,
  tasks,
  users,
  type UserRole,
  type Visibility,
} from "../db/schema.js";
import { approveSuggestion, editSuggestion, rejectSuggestion, SuggestionApplyError } from "../suggestions/apply.js";
import { canViewVisibility } from "../access/visibility.js";

// Every targetType a suggestion can carry, including "decision" -- unlike
// apply.ts's own TABLE_BY_TARGET_TYPE (which deliberately excludes decision
// because approving one needs createDecision/updateDecision's own
// validation), this is read-only lookup for the review UI's "current state"
// column, where a decision's row is exactly as fetchable as any other target.
const CURRENT_STATE_TABLE = {
  objective: objectives,
  initiative: initiatives,
  project: projects,
  task: tasks,
  decision: decisions,
} as const;

// Batch-fetches the current row for every (targetType, targetId) pair among
// the given suggestions -- one query per targetType actually present, not
// N+1 per suggestion. Keyed by "targetType:targetId" since ids aren't
// necessarily unique across different target tables.
async function loadCurrentStates(
  organizationId: string,
  rows: Array<{ targetType: string; targetId: string | null }>,
): Promise<Map<string, Record<string, unknown>>> {
  const idsByType = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.targetId === null) continue;
    const set = idsByType.get(row.targetType) ?? new Set<string>();
    set.add(row.targetId);
    idsByType.set(row.targetType, set);
  }

  const result = new Map<string, Record<string, unknown>>();
  await Promise.all(
    [...idsByType.entries()].map(async ([targetType, idSet]) => {
      const table = CURRENT_STATE_TABLE[targetType as keyof typeof CURRENT_STATE_TABLE];
      if (!table) return;
      const currentRows = await db
        .select()
        .from(table)
        .where(and(eq(table.organizationId, organizationId), inArray(table.id, [...idSet])));
      for (const currentRow of currentRows) {
        result.set(`${targetType}:${currentRow.id}`, currentRow as Record<string, unknown>);
      }
    }),
  );
  return result;
}

// Narrows a fetched current row down to just the fields the suggestion's own
// proposedDiff touches, so the review UI can render "current -> proposed"
// pairs for exactly what's changing, not the entire row. title is always
// included on top of that, even when the diff itself never touches it (an
// operational_update on a task's status/latestUpdate never mentions title) --
// without it, the review card has no way to say *which* existing task/
// decision/etc. a suggestion is about, since proposedDiff for an update to
// an existing entity usually doesn't restate its name at all.
function pickCurrentStateFields(
  currentRow: Record<string, unknown> | undefined,
  proposedDiff: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!currentRow) return null;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(proposedDiff)) {
    if (key in currentRow) result[key] = currentRow[key];
  }
  if ("title" in currentRow) result.title = currentRow.title;
  return result;
}

// The field on a task/project/initiative row (or on a not-yet-created one's
// own proposedDiff) that names its immediate parent -- objective and
// decision aren't included: an objective has no parent to walk up to, and a
// decision doesn't live in the objective/initiative/project hierarchy at all.
const PARENT_ID_FIELD: Record<string, string> = {
  task: "projectId",
  project: "initiativeId",
  initiative: "objectiveId",
};

interface BreadcrumbEntry {
  id: string;
  title: string;
}

interface Breadcrumb {
  objective?: BreadcrumbEntry;
  initiative?: BreadcrumbEntry;
  project?: BreadcrumbEntry;
}

// Resolves "where does this suggestion live" -- the objective/initiative/
// project chain *above* the suggestion's own target -- for the review UI's
// workflow breadcrumb. For an update to an existing task/project/initiative,
// the starting parent id comes off the already-fetched currentStates row
// (loadCurrentStates fetches full rows, so it's already in hand, no extra
// query). For a brand-new entity (targetId null), the same field name is
// read off proposedDiff instead, since that's where the caller is proposing
// to place it. Walks up at most two more levels (project -> initiative ->
// objective), batched as one query per level rather than per suggestion, so
// this stays O(1) queries regardless of how many suggestions are in the list.
async function loadBreadcrumbs(
  organizationId: string,
  rows: Array<{ id: string; targetType: string; targetId: string | null; proposedDiff: unknown }>,
  currentStates: Map<string, Record<string, unknown>>,
): Promise<Map<string, Breadcrumb>> {
  const startParentId = new Map<string, string>(); // suggestion id -> immediate parent id
  const neededProjectIds = new Set<string>();
  const neededInitiativeIds = new Set<string>();
  const neededObjectiveIds = new Set<string>();

  for (const row of rows) {
    const parentField = PARENT_ID_FIELD[row.targetType];
    if (!parentField) continue;
    const source = row.targetId
      ? currentStates.get(`${row.targetType}:${row.targetId}`)
      : (row.proposedDiff as Record<string, unknown>);
    const parentId = source?.[parentField];
    if (typeof parentId !== "string") continue;
    startParentId.set(row.id, parentId);
    if (row.targetType === "task") neededProjectIds.add(parentId);
    else if (row.targetType === "project") neededInitiativeIds.add(parentId);
    else if (row.targetType === "initiative") neededObjectiveIds.add(parentId);
  }

  const projectsById = new Map<string, { id: string; title: string; initiativeId: string }>();
  if (neededProjectIds.size > 0) {
    const found = await db
      .select({ id: projects.id, title: projects.title, initiativeId: projects.initiativeId })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), inArray(projects.id, [...neededProjectIds])));
    for (const p of found) {
      projectsById.set(p.id, p);
      neededInitiativeIds.add(p.initiativeId);
    }
  }

  const initiativesById = new Map<string, { id: string; title: string; objectiveId: string }>();
  if (neededInitiativeIds.size > 0) {
    const found = await db
      .select({ id: initiatives.id, title: initiatives.title, objectiveId: initiatives.objectiveId })
      .from(initiatives)
      .where(and(eq(initiatives.organizationId, organizationId), inArray(initiatives.id, [...neededInitiativeIds])));
    for (const i of found) {
      initiativesById.set(i.id, i);
      neededObjectiveIds.add(i.objectiveId);
    }
  }

  const objectivesById = new Map<string, { id: string; title: string }>();
  if (neededObjectiveIds.size > 0) {
    const found = await db
      .select({ id: objectives.id, title: objectives.title })
      .from(objectives)
      .where(and(eq(objectives.organizationId, organizationId), inArray(objectives.id, [...neededObjectiveIds])));
    for (const o of found) objectivesById.set(o.id, o);
  }

  const result = new Map<string, Breadcrumb>();
  for (const row of rows) {
    const parentId = startParentId.get(row.id);
    if (!parentId) continue;
    const breadcrumb: Breadcrumb = {};

    if (row.targetType === "task") {
      const project = projectsById.get(parentId);
      if (project) breadcrumb.project = { id: project.id, title: project.title };
      const initiative = project ? initiativesById.get(project.initiativeId) : undefined;
      if (initiative) breadcrumb.initiative = { id: initiative.id, title: initiative.title };
      const objective = initiative ? objectivesById.get(initiative.objectiveId) : undefined;
      if (objective) breadcrumb.objective = { id: objective.id, title: objective.title };
    } else if (row.targetType === "project") {
      const initiative = initiativesById.get(parentId);
      if (initiative) breadcrumb.initiative = { id: initiative.id, title: initiative.title };
      const objective = initiative ? objectivesById.get(initiative.objectiveId) : undefined;
      if (objective) breadcrumb.objective = { id: objective.id, title: objective.title };
    } else if (row.targetType === "initiative") {
      const objective = objectivesById.get(parentId);
      if (objective) breadcrumb.objective = { id: objective.id, title: objective.title };
    }

    if (Object.keys(breadcrumb).length > 0) result.set(row.id, breadcrumb);
  }
  return result;
}

// For a task-update suggestion whose proposedDiff sets a *different*
// projectId than the task's current one (the Unsorted re-triage flow, see
// routes/unsorted.ts, is the only producer of this today) -- the plain diff
// view hides projectId entirely (see frontend/lib/formatDiff.ts's
// HIDDEN_DIFF_KEYS, since a foreign key is normally implementation detail),
// so without this a reviewer would have no visual sign of what's actually
// being proposed beyond the reasoning text. Batches one query for the whole
// suggestion list rather than per-suggestion.
async function loadMovingToProjects(
  organizationId: string,
  rows: Array<{ id: string; targetType: string; targetId: string | null; proposedDiff: unknown }>,
  currentStates: Map<string, Record<string, unknown>>,
): Promise<Map<string, { id: string; title: string }>> {
  const neededProjectIds = new Set<string>();
  const proposedProjectIdBySuggestion = new Map<string, string>();

  for (const row of rows) {
    if (row.targetType !== "task" || row.targetId === null) continue;
    const proposedProjectId = (row.proposedDiff as Record<string, unknown>).projectId;
    if (typeof proposedProjectId !== "string") continue;
    const currentProjectId = currentStates.get(`task:${row.targetId}`)?.projectId;
    if (proposedProjectId === currentProjectId) continue;
    proposedProjectIdBySuggestion.set(row.id, proposedProjectId);
    neededProjectIds.add(proposedProjectId);
  }

  if (neededProjectIds.size === 0) return new Map();

  const found = await db
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), inArray(projects.id, [...neededProjectIds])));
  const projectById = new Map(found.map((p) => [p.id, p]));

  const result = new Map<string, { id: string; title: string }>();
  for (const [suggestionId, projectId] of proposedProjectIdBySuggestion) {
    const project = projectById.get(projectId);
    if (project) result.set(suggestionId, project);
  }
  return result;
}

// Only task/decision carry a visibility column (see schema.ts); an
// objective/initiative/project target, or a targetId-null (brand-new
// entity) suggestion, is always viewable -- there's nothing to restrict yet.
// Shared by the GET list filter below and the pre-check on the three action
// routes, so a member can't act on a suggestion via a direct API call that
// the review queue never showed them.
async function isSuggestionTargetViewable(
  organizationId: string,
  targetType: string,
  targetId: string | null,
  role: UserRole,
): Promise<boolean> {
  if (targetId === null) return true;
  if (targetType === "task") {
    const [row] = await db
      .select({ visibility: tasks.visibility })
      .from(tasks)
      .where(and(eq(tasks.id, targetId), eq(tasks.organizationId, organizationId)));
    return row === undefined || canViewVisibility(role, row.visibility);
  }
  if (targetType === "decision") {
    const [row] = await db
      .select({ visibility: decisions.visibility })
      .from(decisions)
      .where(and(eq(decisions.id, targetId), eq(decisions.organizationId, organizationId)));
    return row === undefined || canViewVisibility(role, row.visibility);
  }
  return true;
}

// Combines a suggestion-id lookup with isSuggestionTargetViewable, for the
// three action routes below -- they only have a suggestion id, not the
// target type/id the GET list already had in hand. Returns true (i.e. "not
// blocked here") when the suggestion doesn't exist at all -- that case is
// already handled downstream by approveSuggestion/editSuggestion/
// rejectSuggestion's own existing "not found" -> 409 path, which this
// pre-check shouldn't change; it only ever turns a genuinely-existing but
// not-viewable suggestion into a 404.
async function isSuggestionViewable(organizationId: string, suggestionId: string, role: UserRole): Promise<boolean> {
  const [row] = await db
    .select({ targetType: suggestions.targetType, targetId: suggestions.targetId })
    .from(suggestions)
    .where(and(eq(suggestions.id, suggestionId), eq(suggestions.organizationId, organizationId)));
  if (!row) return true;
  return isSuggestionTargetViewable(organizationId, row.targetType, row.targetId, role);
}

export async function suggestionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { status?: string } }>("/api/suggestions", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    // No explicit status means "awaiting a review decision" -- an edited
    // suggestion hasn't been approved/rejected yet, so it belongs in that set too.
    const statusFilter = request.query.status
      ? eq(suggestions.status, request.query.status as never)
      : inArray(suggestions.status, ["pending", "edited"]);

    const rows = await db
      .select({
        id: suggestions.id,
        targetType: suggestions.targetType,
        targetId: suggestions.targetId,
        changeType: suggestions.changeType,
        proposedDiff: suggestions.proposedDiff,
        reasoning: suggestions.reasoning,
        confidence: suggestions.confidence,
        status: suggestions.status,
        createdAt: suggestions.createdAt,
        reviewedAt: suggestions.reviewedAt,
        // Resolved the same way activity.ts resolves auditLog.actorId -- a left
        // join so a not-yet-reviewed suggestion (reviewedBy null) still returns
        // a row instead of being dropped.
        reviewerName: users.name,
        reviewerEmail: users.email,
        source: {
          id: sources.id,
          type: sources.type,
          externalId: sources.externalId,
          receivedAt: sources.receivedAt,
        },
      })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .leftJoin(users, eq(users.id, suggestions.reviewedBy))
      .where(and(eq(suggestions.organizationId, organizationId), statusFilter))
      .orderBy(desc(suggestions.createdAt));

    const currentStates = await loadCurrentStates(organizationId, rows);
    const [breadcrumbs, movingToProjects] = await Promise.all([
      loadBreadcrumbs(organizationId, rows, currentStates),
      loadMovingToProjects(organizationId, rows, currentStates),
    ]);
    const role = request.user!.role;
    const withCurrentState = rows
      // A suggestion targeting a task/decision the caller can't view (per
      // that row's own visibility, already fetched above) is hidden from the
      // queue entirely -- not just its currentState -- since reasoning/
      // proposedDiff can themselves describe the restricted content.
      .filter((row) => {
        if (row.targetId === null || (row.targetType !== "task" && row.targetType !== "decision")) return true;
        const currentRow = currentStates.get(`${row.targetType}:${row.targetId}`);
        const visibility = currentRow?.visibility as Visibility | undefined;
        return visibility === undefined || canViewVisibility(role, visibility);
      })
      .map((row) => ({
        ...row,
        // null for a brand-new entity (targetId null) or a target that no
        // longer resolves (shouldn't happen today -- nothing deletes rows --
        // but fails safe rather than crashing the response).
        currentState: pickCurrentStateFields(
          row.targetId ? currentStates.get(`${row.targetType}:${row.targetId}`) : undefined,
          row.proposedDiff as Record<string, unknown>,
        ),
        breadcrumb: breadcrumbs.get(row.id) ?? null,
        movingToProject: movingToProjects.get(row.id) ?? null,
      }));

    reply.send({ suggestions: withCurrentState });
  });

  app.post<{ Params: { id: string } }>("/api/suggestions/:id/approve", async (request, reply) => {
    if (!(await isSuggestionViewable(request.user!.organizationId, request.params.id, request.user!.role))) {
      reply.code(404).send({ error: "Suggestion not found" });
      return;
    }
    try {
      const updated = await approveSuggestion(db, {
        organizationId: request.user!.organizationId,
        suggestionId: request.params.id,
        reviewerId: request.user!.userId,
      });
      reply.send({ suggestion: updated });
    } catch (err) {
      if (err instanceof SuggestionApplyError) {
        reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Approves several suggestions in one request -- for the review queue's
  // "approve all ready-to-approve" action, where clicking through each one
  // individually is real friction once there are a dozen high-confidence
  // items sitting in the same tier. Each id goes through the exact same
  // isSuggestionViewable check and approveSuggestion call the single-approve
  // route uses, one at a time (not parallelized) so two suggestions that
  // happen to target the same entity apply in a stable, predictable order
  // rather than racing. One bad id never aborts the rest -- the response
  // reports each outcome individually so the UI can show a partial result.
  const MAX_BULK_APPROVE = 100;
  app.post<{ Body: { ids?: string[] } }>("/api/suggestions/bulk-approve", async (request, reply) => {
    const ids = request.body?.ids;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      reply.code(400).send({ error: "ids is required and must be a non-empty array" });
      return;
    }
    if (ids.length > MAX_BULK_APPROVE) {
      reply.code(400).send({ error: `Cannot approve more than ${MAX_BULK_APPROVE} suggestions at once` });
      return;
    }

    const organizationId = request.user!.organizationId;
    const role = request.user!.role;
    const approved: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      if (!(await isSuggestionViewable(organizationId, id, role))) {
        failed.push({ id, error: "Suggestion not found" });
        continue;
      }
      try {
        const updated = await approveSuggestion(db, {
          organizationId,
          suggestionId: id,
          reviewerId: request.user!.userId,
        });
        approved.push(updated.id);
      } catch (err) {
        if (err instanceof SuggestionApplyError) {
          failed.push({ id, error: err.message });
        } else {
          throw err;
        }
      }
    }

    reply.send({ approved, failed });
  });

  app.patch<{ Params: { id: string }; Body: { proposedDiff?: Record<string, unknown> } }>(
    "/api/suggestions/:id",
    async (request, reply) => {
      const diff = request.body?.proposedDiff;
      if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
        reply.code(400).send({ error: "proposedDiff is required" });
        return;
      }
      if (!(await isSuggestionViewable(request.user!.organizationId, request.params.id, request.user!.role))) {
        reply.code(404).send({ error: "Suggestion not found" });
        return;
      }
      try {
        const updated = await editSuggestion(db, {
          organizationId: request.user!.organizationId,
          suggestionId: request.params.id,
          actorId: request.user!.userId,
          diff,
        });
        reply.send({ suggestion: updated });
      } catch (err) {
        if (err instanceof SuggestionApplyError) {
          reply.code(409).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/suggestions/:id/reject", async (request, reply) => {
    if (!(await isSuggestionViewable(request.user!.organizationId, request.params.id, request.user!.role))) {
      reply.code(404).send({ error: "Suggestion not found" });
      return;
    }
    try {
      const updated = await rejectSuggestion(db, {
        organizationId: request.user!.organizationId,
        suggestionId: request.params.id,
        reviewerId: request.user!.userId,
      });
      reply.send({ suggestion: updated });
    } catch (err) {
      if (err instanceof SuggestionApplyError) {
        reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
