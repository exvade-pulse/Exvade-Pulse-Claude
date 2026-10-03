import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import {
  decisions,
  initiatives,
  LIVE_DECISION_STATUSES,
  milestones,
  objectives,
  projects,
  risks,
  sources,
  suggestions,
  tasks,
  TERMINAL_TASK_STATUSES,
  users,
  type EntityNodeType,
  type UserRole,
  type Visibility,
} from "../db/schema.js";
import { approveSuggestion, editSuggestion, MOVABLE_CHANGE_TYPES, PARENT_OF, parseNewParent, rejectSuggestion, SuggestionApplyError } from "../suggestions/apply.js";
import { canViewVisibility } from "../access/visibility.js";
import { resolveNames } from "../relationships/manage.js";
import { LIKELY_DUPLICATE_THRESHOLD, titleSimilarity, titleTokens } from "../suggestions/similarity.js";
import { syncDeadlineItems } from "../reports/deadlineItems.js";

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
  milestone: milestones,
  risk: risks,
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
  milestone: "objectiveId",
  risk: "objectiveId",
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
    else neededObjectiveIds.add(parentId);
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
    } else {
      const objective = objectivesById.get(parentId);
      if (objective) breadcrumb.objective = { id: objective.id, title: objective.title };
    }

    if (Object.keys(breadcrumb).length > 0) result.set(row.id, breadcrumb);
  }
  return result;
}

// Where a suggestion would put its record, for the "Moving to" line on the
// review card -- the plain diff view hides parent ids (see
// frontend/lib/formatDiff.ts's HIDDEN_DIFF_KEYS), so without this a reviewer
// would see a move only in the reasoning text. Covers an existing record
// changing parent, and a new destination the reviewer named in Edit (see
// apply.ts's NewParent), which only exists once the card is approved.
// Batches one query per level for the whole list.
export interface MovingTo {
  level: "objective" | "initiative" | "project";
  title: string;
  isNew: boolean;
  under: string | null;
}

async function loadMovingTo(
  organizationId: string,
  rows: Array<{ id: string; targetType: string; targetId: string | null; changeType: string; proposedDiff: unknown }>,
  currentStates: Map<string, Record<string, unknown>>,
): Promise<Map<string, MovingTo>> {
  const result = new Map<string, MovingTo>();
  const wanted: Array<{ suggestionId: string; level: MovingTo["level"]; id: string; isNew: false } | { suggestionId: string; level: MovingTo["level"]; title: string; underId: string | null; isNew: true }> = [];
  const idsByLevel: Record<MovingTo["level"], Set<string>> = { objective: new Set(), initiative: new Set(), project: new Set() };

  for (const row of rows) {
    if (!(row.targetType in PARENT_OF) || !MOVABLE_CHANGE_TYPES.includes(row.changeType)) continue;
    const parent = PARENT_OF[row.targetType as keyof typeof PARENT_OF];
    const diff = row.proposedDiff as Record<string, unknown>;
    const np = parseNewParent(diff.newParent);
    if (np) {
      wanted.push({ suggestionId: row.id, level: parent.level, title: np.title, underId: np.parentId, isNew: true });
      if (np.parentId && parent.level !== "objective") idsByLevel[PARENT_OF[parent.level].level].add(np.parentId);
      continue;
    }
    const proposed = diff[parent.field];
    if (row.targetId === null || typeof proposed !== "string") continue;
    if (proposed === currentStates.get(`${row.targetType}:${row.targetId}`)?.[parent.field]) continue;
    wanted.push({ suggestionId: row.id, level: parent.level, id: proposed, isNew: false });
    idsByLevel[parent.level].add(proposed);
  }
  if (wanted.length === 0) return result;

  const titleById = new Map<string, string>();
  const lookups: Array<[MovingTo["level"], typeof objectives | typeof initiatives | typeof projects]> = [
    ["objective", objectives],
    ["initiative", initiatives],
    ["project", projects],
  ];
  await Promise.all(
    lookups.map(async ([level, table]) => {
      const ids = [...idsByLevel[level]];
      if (ids.length === 0) return;
      const found = await db
        .select({ id: table.id, title: table.title })
        .from(table)
        .where(and(eq(table.organizationId, organizationId), inArray(table.id, ids)));
      for (const r of found) titleById.set(r.id, r.title);
    }),
  );

  for (const w of wanted) {
    if (w.isNew) {
      result.set(w.suggestionId, { level: w.level, title: w.title, isNew: true, under: w.underId ? titleById.get(w.underId) ?? null : null });
    } else {
      const title = titleById.get(w.id);
      if (title) result.set(w.suggestionId, { level: w.level, title, isNew: false, under: null });
    }
  }
  return result;
}

export interface RelationshipEndpoints {
  from: { type: EntityNodeType; id: string; title: string };
  to: { type: EntityNodeType; id: string; title: string };
}

// For a relationship-type suggestion, resolves both endpoints' display
// titles for the review card -- proposedDiff only carries type/id (see
// interpret.ts's relationshipDiffSchema and relationshipDetection.ts), and a
// reviewer needs to see what's actually being connected, not just its raw
// id. Reuses relationships/manage.ts's resolveNames (the same batch lookup
// RelationshipsPanel's listRelationshipsForEntity already relies on) so
// there's one place that knows how to turn a (type, id) into a title.
async function loadRelationshipEndpoints(
  organizationId: string,
  rows: Array<{ id: string; targetType: string; proposedDiff: unknown }>,
): Promise<Map<string, RelationshipEndpoints>> {
  const relationshipRows = rows.filter((row) => row.targetType === "relationship");
  if (relationshipRows.length === 0) return new Map();

  const refs: Array<{ type: EntityNodeType; id: string }> = [];
  for (const row of relationshipRows) {
    const diff = row.proposedDiff as { fromType?: EntityNodeType; fromId?: string; toType?: EntityNodeType; toId?: string };
    if (diff.fromType && diff.fromId) refs.push({ type: diff.fromType, id: diff.fromId });
    if (diff.toType && diff.toId) refs.push({ type: diff.toType, id: diff.toId });
  }

  const names = await resolveNames(db, organizationId, refs);
  const result = new Map<string, RelationshipEndpoints>();
  for (const row of relationshipRows) {
    const diff = row.proposedDiff as { fromType?: EntityNodeType; fromId?: string; toType?: EntityNodeType; toId?: string };
    if (!diff.fromType || !diff.fromId || !diff.toType || !diff.toId) continue;
    result.set(row.id, {
      from: { type: diff.fromType, id: diff.fromId, title: names.get(`${diff.fromType}:${diff.fromId}`) ?? "(unknown)" },
      to: { type: diff.toType, id: diff.toId, title: names.get(`${diff.toType}:${diff.toId}`) ?? "(unknown)" },
    });
  }
  return result;
}

// For a merge suggestion (target = the duplicate), the record it would be
// merged into -- the review card needs both names to be a real question.
async function loadMergeTargets(
  organizationId: string,
  rows: Array<{ id: string; targetType: string; changeType: string; proposedDiff: unknown }>,
): Promise<Map<string, { id: string; title: string }>> {
  const merges = rows.filter((row) => row.changeType === "merge");
  if (merges.length === 0) return new Map();
  const keepIdOf = (row: (typeof merges)[number]) => (row.proposedDiff as { supersededById?: unknown }).supersededById;
  const refs = merges
    .filter((row) => typeof keepIdOf(row) === "string")
    .map((row) => ({ type: row.targetType as EntityNodeType, id: keepIdOf(row) as string }));
  const names = await resolveNames(db, organizationId, refs);
  const result = new Map<string, { id: string; title: string }>();
  for (const row of merges) {
    const keepId = keepIdOf(row);
    if (typeof keepId !== "string") continue;
    result.set(row.id, { id: keepId, title: names.get(`${row.targetType}:${keepId}`) ?? "(unknown)" });
  }
  return result;
}

export interface QuestionDetails {
  objective: string;
  decisions: string[];
  tasks: string[];
  projects: string[];
  convertDecision: string | null;
}

// Names for everything a proposed strategic question would link, so the
// card reads "Links: Needle gauge testing, ..." instead of ids. Also
// reports which proposals involve a restricted task/decision, so a member
// never sees one (same rule as a suggestion targeting a restricted row).
async function loadQuestionDetails(
  organizationId: string,
  rows: Array<{ id: string; changeType: string; proposedDiff: unknown }>,
  role: UserRole,
): Promise<{ details: Map<string, QuestionDetails>; hidden: Set<string> }> {
  const questions = rows.filter((row) => row.changeType === "question");
  const details = new Map<string, QuestionDetails>();
  const hidden = new Set<string>();
  if (questions.length === 0) return { details, hidden };
  const idList = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const parsed = questions.map((row) => {
    const diff = row.proposedDiff as Record<string, unknown>;
    const convert = typeof diff.convertDecisionId === "string" ? diff.convertDecisionId : null;
    return {
      row,
      objectiveId: typeof diff.objectiveId === "string" ? diff.objectiveId : null,
      decisionIds: [...idList(diff.decisionIds), ...(convert ? [convert] : [])],
      convert,
      taskIds: idList(diff.taskIds),
      projectIds: idList(diff.projectIds),
    };
  });
  const refs: Array<{ type: EntityNodeType; id: string }> = parsed.flatMap((p) => [
    ...(p.objectiveId ? [{ type: "objective" as const, id: p.objectiveId }] : []),
    ...p.decisionIds.map((id) => ({ type: "decision" as const, id })),
    ...p.taskIds.map((id) => ({ type: "task" as const, id })),
    ...p.projectIds.map((id) => ({ type: "project" as const, id })),
  ]);
  const allDecisionIds = [...new Set(parsed.flatMap((p) => p.decisionIds))];
  const allTaskIds = [...new Set(parsed.flatMap((p) => p.taskIds))];
  const [names, decisionVis, taskVis] = await Promise.all([
    resolveNames(db, organizationId, refs),
    allDecisionIds.length && role !== "admin"
      ? db.select({ id: decisions.id, visibility: decisions.visibility }).from(decisions).where(and(eq(decisions.organizationId, organizationId), inArray(decisions.id, allDecisionIds)))
      : [],
    allTaskIds.length && role !== "admin"
      ? db.select({ id: tasks.id, visibility: tasks.visibility }).from(tasks).where(and(eq(tasks.organizationId, organizationId), inArray(tasks.id, allTaskIds)))
      : [],
  ]);
  const restricted = new Set([...decisionVis, ...taskVis].filter((r) => !canViewVisibility(role, r.visibility)).map((r) => r.id));
  const nameOf = (type: string, id: string) => names.get(`${type}:${id}`) ?? "(no longer exists)";
  for (const p of parsed) {
    if ([...p.decisionIds, ...p.taskIds].some((id) => restricted.has(id))) hidden.add(p.row.id);
    details.set(p.row.id, {
      objective: p.objectiveId ? nameOf("objective", p.objectiveId) : "(unknown objective)",
      decisions: p.decisionIds.filter((id) => id !== p.convert).map((id) => nameOf("decision", id)),
      tasks: p.taskIds.map((id) => nameOf("task", id)),
      projects: p.projectIds.map((id) => nameOf("project", id)),
      convertDecision: p.convert ? nameOf("decision", p.convert) : null,
    });
  }
  return { details, hidden };
}

export interface DuplicateHint {
  kind: "existing" | "pending";
  id: string;
  title: string;
  similarity: number;
}

// A free, no-model hint on pending "create a new task/decision" suggestions
// whose title reads like one that already exists, or like an earlier
// pending suggestion -- so the reviewer can reject the copy instead of
// approving the same thing three times. Informational only.
async function loadDuplicateHints(
  organizationId: string,
  rows: Array<{ id: string; targetType: string; targetId: string | null; changeType: string; proposedDiff: unknown; createdAt: Date }>,
): Promise<Map<string, DuplicateHint>> {
  const titleOf = (row: { proposedDiff: unknown }) => {
    const title = (row.proposedDiff as { title?: unknown }).title;
    return typeof title === "string" ? title : null;
  };
  const creates = rows
    .filter((row) => row.targetId === null && row.changeType !== "merge" && (row.targetType === "task" || row.targetType === "decision"))
    .filter((row) => titleOf(row) !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (creates.length === 0) return new Map();

  const [existingTasks, existingDecisions] = await Promise.all([
    db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.organizationId, organizationId), notInArray(tasks.status, TERMINAL_TASK_STATUSES))),
    db
      .select({ id: decisions.id, title: decisions.title })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, LIVE_DECISION_STATUSES))),
  ]);
  const existing = {
    task: existingTasks.map((t) => ({ ...t, tokens: titleTokens(t.title) })),
    decision: existingDecisions.map((d) => ({ ...d, tokens: titleTokens(d.title) })),
  };

  const result = new Map<string, DuplicateHint>();
  const earlier: Array<{ id: string; type: string; title: string; tokens: Set<string> }> = [];
  for (const row of creates) {
    const title = titleOf(row)!;
    const tokens = titleTokens(title);
    let best: DuplicateHint | null = null;
    for (const candidate of existing[row.targetType as "task" | "decision"]) {
      const similarity = titleSimilarity(tokens, candidate.tokens);
      if (similarity >= LIKELY_DUPLICATE_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { kind: "existing", id: candidate.id, title: candidate.title, similarity };
      }
    }
    for (const candidate of earlier) {
      if (candidate.type !== row.targetType) continue;
      const similarity = titleSimilarity(tokens, candidate.tokens);
      if (similarity >= LIKELY_DUPLICATE_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { kind: "pending", id: candidate.id, title: candidate.title, similarity };
      }
    }
    if (best) result.set(row.id, { ...best, similarity: Math.round(best.similarity * 100) / 100 });
    earlier.push({ id: row.id, type: row.targetType, title, tokens });
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
    // Model-free and idempotent: keeps "deadline passed" questions current
    // before the queue is read.
    await syncDeadlineItems(db, organizationId);
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
        // Set by dedupe.ts's mergeOrInsertSuggestion when this suggestion
        // proposed regressing a task field that's already been confirmed by
        // more recent evidence -- see tasks.fieldEvidence in schema.ts. Null
        // in the overwhelming common case.
        conflicts: suggestions.conflicts,
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
    // Duplicate hints only make sense while something is still awaiting a call.
    const awaitingRows = rows.filter((row) => row.status === "pending" || row.status === "edited");
    const role = request.user!.role;
    const [breadcrumbs, movingTo, relationshipEndpoints, mergeTargets, duplicateHints, questionInfo] = await Promise.all([
      loadBreadcrumbs(organizationId, rows, currentStates),
      loadMovingTo(organizationId, rows, currentStates),
      loadRelationshipEndpoints(organizationId, rows),
      loadMergeTargets(organizationId, rows),
      loadDuplicateHints(organizationId, awaitingRows),
      loadQuestionDetails(organizationId, rows, role),
    ]);
    const withCurrentState = rows
      // A suggestion targeting a task/decision the caller can't view (per
      // that row's own visibility, already fetched above) is hidden from the
      // queue entirely -- not just its currentState -- since reasoning/
      // proposedDiff can themselves describe the restricted content.
      .filter((row) => {
        if (questionInfo.hidden.has(row.id)) return false;
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
        movingTo: movingTo.get(row.id) ?? null,
        relationshipEndpoints: relationshipEndpoints.get(row.id) ?? null,
        mergeInto: mergeTargets.get(row.id) ?? null,
        likelyDuplicateOf: duplicateHints.get(row.id) ?? null,
        questionDetails: questionInfo.details.get(row.id) ?? null,
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
        reviewerRole: request.user!.role,
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
          reviewerRole: request.user!.role,
        });
        approved.push(updated.id);
      } catch (err) {
        if (err instanceof SuggestionApplyError) {
          failed.push({ id, error: err.message });
        } else {
          // An unexpected (non-SuggestionApplyError) failure on one item --
          // e.g. a malformed proposedDiff the whitelist/required-field checks
          // didn't anticipate -- must not take the rest of the batch down
          // with it. Logged for visibility (this is a real bug, not an
          // ordinary "already approved" style rejection) but reported back
          // as an ordinary failure, same as the expected case.
          request.log.error({ err, suggestionId: id }, "Unexpected error approving a suggestion during bulk-approve");
          failed.push({ id, error: "Something went wrong approving this suggestion" });
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
