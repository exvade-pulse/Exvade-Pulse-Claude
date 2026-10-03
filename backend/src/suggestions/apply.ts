import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, DbOrTx } from "../db/client.js";
import { auditLog, dateTypeEnum, decisions, initiatives, objectiveHealthEnum, objectiveHealthHistory, objectives, projects, sources, suggestions, tasks, TERMINAL_TASK_STATUSES, users, type EntityNodeType, type ObjectiveHealth, type RelationType, type UserRole } from "../db/schema.js";
import { createMilestone, createRisk, OverviewError, updateMilestone, updateRisk } from "../overview/manage.js";
import { createDecision, DecisionError, supersedeDecision, updateDecision } from "../decisions/manage.js";
import { createRelationship, RelationshipError } from "../relationships/manage.js";
import { supersedeHierarchy } from "../entities/supersedeHierarchy.js";
import { applyQuestionProposal, QuestionError, type QuestionProposal } from "../questions/manage.js";
import { supersedeTask, SupersedeError } from "../tasks/supersede.js";
import type { ConflictEntry } from "./dedupe.js";

export class SuggestionApplyError extends Error {}

const TABLE_BY_TARGET_TYPE = {
  objective: objectives,
  initiative: initiatives,
  project: projects,
  task: tasks,
} as const;

// The task fields worth tracking "when was this actually last confirmed, and
// by what source" for -- see schema.ts's tasks.fieldEvidence comment. title
// is structural and left out; description is tracked because an older source
// approved late must not replace a newer summary either.
const TRACKED_EVIDENCE_FIELDS = ["status", "latestUpdate", "nextAction", "owner", "description", "dueDate", "waitingFor"] as const;

// A task date arrives as "2026-10-14" (or a full ISO string); it is stored
// as that calendar date at midnight UTC. Anything unparseable is dropped
// rather than failing the whole approval, as is an unknown date type.
export function normalizeTaskDates(fields: Record<string, unknown>): void {
  for (const key of ["dueDate", "followUpOn"]) {
    if (!(key in fields)) continue;
    const value = fields[key];
    if (value === null || value === "") {
      fields[key] = null;
      continue;
    }
    const day = typeof value === "string" ? value.slice(0, 10) : value instanceof Date ? value.toISOString().slice(0, 10) : "";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00.000Z`) : null;
    if (date && !Number.isNaN(date.getTime())) fields[key] = date;
    else delete fields[key];
  }
  if ("dueDateType" in fields && fields.dueDateType !== null && !dateTypeEnum.enumValues.includes(fields.dueDateType as never)) {
    delete fields.dueDateType;
  }
}

// Fields a brand-new row of each type cannot be created without -- a real
// parent id (except objective, which has none) plus a title. interpret.ts's
// SYSTEM_PROMPT already instructs the model to always include the parent id,
// but that's prompt guidance, not enforcement: a malformed draft (parent id
// omitted) previously reached the database uncaught, where the table's own
// NOT NULL constraint rejected it with a raw, unhandled Postgres error --
// crashing the whole request (including the rest of a bulk-approve batch)
// instead of failing this one suggestion gracefully. Checked below before
// ever attempting the insert.
// Exported so interpret.ts's validateSuggestionInput can reject a malformed
// new-entity draft at ingestion time too -- catching it here (apply.ts) is
// what stops the crash, but rejecting it before it's ever stored as a
// suggestion is better still, since a suggestion missing required fields can
// never actually be approved no matter how many times it's retried.
export const REQUIRED_CREATE_FIELDS: Record<Exclude<SuggestionTargetType, "decision" | "relationship" | "question">, string[]> = {
  objective: ["title"],
  initiative: ["objectiveId", "title"],
  project: ["initiativeId", "title"],
  task: ["projectId", "title"],
  milestone: ["objectiveId", "title"],
  risk: ["objectiveId", "title"],
};

// "decision" and "relationship" are valid suggestion targetTypes but
// deliberately have no entry in TABLE_BY_TARGET_TYPE: neither is a drop-in
// "insert this table with whitelisted fields" case like the other four --
// decision needs org-scoped relatedTaskId/sourceId validation and its own
// audit_log entry (decisions/manage.ts's createDecision), and relationship
// needs both-endpoints-exist validation with no single row to update
// (relationships/manage.ts's createRelationship) -- so each is handled as
// its own branch in approveSuggestion instead. ALLOWED_FIELDS/
// pickAllowedFields still cover both, since interpret.ts's sanitization step
// whitelists every targetType the model may propose.
// "milestone" and "risk" (Executive Overview) are also applied by their own
// branch, through overview/manage.ts, which validates and audit-logs them.
export type SuggestionTargetType = keyof typeof TABLE_BY_TARGET_TYPE | "decision" | "relationship" | "question" | "milestone" | "risk";

// Whitelists what a proposed_diff may set on each target type, so an AI-authored
// (or hand-edited) diff can never smuggle in organization_id or other fields the
// review flow doesn't own.
// "owner" is deliberately only on these four hierarchy types, not "decision":
// decisions already have their own decider/stakeholders fields for "who's
// responsible", and this is a single free-text field (not a stakeholders
// array) by scope decision -- see the comment on schema.ts's owner columns.
export const ALLOWED_FIELDS: Record<SuggestionTargetType, string[]> = {
  // health/healthRationale/rationale/displayOrder feed the Executive
  // Overview; approving a health change also records its history.
  objective: ["title", "description", "status", "priority", "owner", "rationale", "health", "healthRationale", "displayOrder"],
  initiative: ["objectiveId", "title", "description", "status", "priority", "owner"],
  project: ["initiativeId", "title", "description", "status", "owner"],
  task: ["projectId", "title", "description", "status", "latestUpdate", "nextAction", "owner", "dueDate", "dueDateType", "dueLabel", "waitingFor", "followUpOn"],
  decision: [
    "title",
    "whyItMatters",
    "relevantContext",
    "suggestedNextStep",
    "decider",
    "stakeholders",
    "dueDate",
    "relatedTaskId",
    "objectiveId",
    "recommendation",
    "impactOfDelay",
  ],
  milestone: ["objectiveId", "title", "successCriteria", "owner", "baselineDate", "forecastDate", "actualDate", "confidence", "state"],
  risk: ["objectiveId", "milestoneId", "title", "impact", "likelihood", "mitigation", "owner", "nextReviewAt", "escalation", "status"],
  relationship: ["fromType", "fromId", "toType", "toId", "relationType", "note"],
  question: ["objectiveId", "title", "hypothesis", "decisionIds", "taskIds", "projectIds", "convertDecisionId", "newDecisions", "label", "nextAction", "keyDependency", "owner"],
};

// Fields a "context" (Info Share) suggestion may touch on the four hierarchy
// types -- deliberately excludes every current-state field (status,
// latestUpdate, nextAction, priority) so approving one can only add
// background, never silently become the entity's current operational state.
// "decision" is not in this map: it has its own changeType vocabulary and a
// dedicated relevantContext field, so this restriction doesn't apply to it.
const CONTEXT_ONLY_FIELDS: Partial<Record<SuggestionTargetType, string[]>> = {
  objective: ["description", "owner"],
  initiative: ["description", "owner"],
  project: ["description", "owner"],
  task: ["description", "owner"],
};

// Exported so the interpretation pipeline can sanitize a model-authored diff
// against the same whitelist this module enforces at apply time -- one source
// of truth for what each target type may set. changeType narrows the
// whitelist further for "context": see CONTEXT_ONLY_FIELDS above.
export function pickAllowedFields(
  targetType: SuggestionTargetType,
  changeType: string,
  diff: Record<string, unknown>,
) {
  // A merge only ever says which record to keep; nothing else rides along.
  if (changeType === "merge") {
    return "supersededById" in diff ? { supersededById: diff.supersededById } : {};
  }
  // A replacement only ever names the new task's own few fields.
  if (changeType === "replace") {
    const proposed = diff.newTask;
    if (!proposed || typeof proposed !== "object") return {};
    const newTask: Record<string, unknown> = {};
    for (const key of ["title", "nextAction", "description"]) {
      if (key in proposed) newTask[key] = (proposed as Record<string, unknown>)[key];
    }
    return { newTask };
  }
  const contextFields = changeType === "context" ? CONTEXT_ONLY_FIELDS[targetType] : undefined;
  const allowed = contextFields ?? ALLOWED_FIELDS[targetType];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in diff) {
      result[key] = diff[key];
    }
  }
  return result;
}

// Where each level sits in the hierarchy: the field that points at its
// parent, and the parent's level.
export const PARENT_OF = {
  initiative: { field: "objectiveId", level: "objective" },
  project: { field: "initiativeId", level: "initiative" },
  task: { field: "projectId", level: "project" },
} as const;
type ChildLevel = keyof typeof PARENT_OF;
type HierarchyLevel = "objective" | "initiative" | "project";

// Change types whose card offers the "Move to" picker. Context, cleanup,
// merge and the rest either can't move a record or mean something else.
export const MOVABLE_CHANGE_TYPES = ["operational_update", "new_task"];

// A reviewer can send a record somewhere that doesn't exist yet: the edit
// stores { newParent: { title, parentId } } (parentId is where the new
// parent itself goes; null for a new objective) and approval creates it.
// Only a person's edit can set this -- it's not in ALLOWED_FIELDS, so no
// AI-authored diff ever carries it.
export interface NewParent {
  title: string;
  parentId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseNewParent(value: unknown): NewParent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 300) : "";
  if (!title) return null;
  return { title, parentId: typeof raw.parentId === "string" && raw.parentId ? raw.parentId : null };
}

function isMovable(targetType: string, changeType: string): targetType is ChildLevel {
  return targetType in PARENT_OF && MOVABLE_CHANGE_TYPES.includes(changeType);
}

// The record must exist in this organization and not be merged away.
async function assertLiveInOrg(tx: DbOrTx, organizationId: string, level: HierarchyLevel, id: unknown, what: string) {
  const table = TABLE_BY_TARGET_TYPE[level];
  if (typeof id !== "string" || !UUID.test(id)) throw new SuggestionApplyError(`Pick the ${what} again`);
  const [row] = await tx
    .select({ status: table.status })
    .from(table)
    .where(and(eq(table.id, id), eq(table.organizationId, organizationId)));
  if (!row || row.status === "superseded") throw new SuggestionApplyError(`That ${what} no longer exists; pick another`);
}

// Reuses an existing live record with the same name in the same place, so
// several cards pointed at the same new project share one.
async function findOrCreateParent(
  tx: DbOrTx,
  params: { organizationId: string; reviewerId: string; suggestionId: string },
  level: HierarchyLevel,
  np: NewParent,
): Promise<string> {
  const { organizationId } = params;
  const table = TABLE_BY_TARGET_TYPE[level];
  const grand = level === "objective" ? null : PARENT_OF[level];
  if (grand) await assertLiveInOrg(tx, organizationId, grand.level, np.parentId, `${grand.level} for the new ${level}`);
  const placement = grand ? { [grand.field]: np.parentId! } : {};

  const conditions = [eq(table.organizationId, organizationId), sql`lower(${table.title}) = lower(${np.title})`, sql`${table.status} <> 'superseded'`];
  if (level === "initiative") conditions.push(eq(initiatives.objectiveId, np.parentId!));
  if (level === "project") conditions.push(eq(projects.initiativeId, np.parentId!));
  const [existing] = await tx.select({ id: table.id }).from(table).where(and(...conditions));
  if (existing) return existing.id;

  const [{ id }] = await tx
    .insert(table)
    .values({ organizationId, title: np.title, ...placement } as never)
    .returning({ id: table.id });
  await tx.insert(auditLog).values({
    organizationId,
    actorId: params.reviewerId,
    action: `${level}.created`,
    entityType: level,
    entityId: id,
    details: { title: np.title, viaSuggestionId: params.suggestionId },
  });
  return id;
}

interface ApplyParams {
  organizationId: string;
  suggestionId: string;
  reviewerId: string;
  // Some approvals are admin-only (moving a milestone's committed
  // baseline); unknown means the stricter "member".
  reviewerRole?: UserRole;
}

// A decision's overview link must point at a live objective in this org.
async function assertLiveObjective(tx: DbOrTx, organizationId: string, id: unknown) {
  if (id === null || id === undefined) return;
  if (typeof id !== "string" || !UUID.test(id)) throw new SuggestionApplyError("That outcome wasn't found");
  const [row] = await tx
    .select({ id: objectives.id })
    .from(objectives)
    .where(and(eq(objectives.id, id), eq(objectives.organizationId, organizationId), inArray(objectives.status, ["active", "paused"])));
  if (!row) throw new SuggestionApplyError("That outcome wasn't found");
}

export async function approveSuggestion(db: Database, params: ApplyParams) {
  return db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.id, params.suggestionId), eq(suggestions.organizationId, params.organizationId)));

    if (!suggestion) {
      throw new SuggestionApplyError("Suggestion not found");
    }
    if (suggestion.status !== "pending" && suggestion.status !== "edited") {
      throw new SuggestionApplyError(`Suggestion is already ${suggestion.status}`);
    }

    const targetType = suggestion.targetType as SuggestionTargetType;
    const fields = pickAllowedFields(
      targetType,
      suggestion.changeType,
      suggestion.proposedDiff as Record<string, unknown>,
    );

    let resultTargetId: string;
    const staleConflicts: ConflictEntry[] = [];

    if (suggestion.changeType === "merge") {
      // A duplicate merge: the target is the duplicate, supersededById the
      // record to keep. Neither row is deleted -- see supersedeDecision /
      // supersedeTask. Their own errors (a record since superseded, a self-
      // merge) fail this one suggestion gracefully.
      const keepId = fields.supersededById;
      if (typeof keepId !== "string" || !suggestion.targetId) {
        throw new SuggestionApplyError("Merge suggestion is missing the record to keep");
      }
      const merge = { organizationId: params.organizationId, supersededById: keepId, actorId: params.reviewerId };
      try {
        if (targetType === "decision") {
          await supersedeDecision(tx, { ...merge, decisionId: suggestion.targetId });
        } else if (targetType === "task") {
          await supersedeTask(tx, { ...merge, taskId: suggestion.targetId });
        } else if (targetType === "objective" || targetType === "initiative" || targetType === "project") {
          await supersedeHierarchy(tx, { ...merge, level: targetType, id: suggestion.targetId });
        } else {
          throw new SuggestionApplyError(`Merging isn't supported for ${targetType}`);
        }
      } catch (err) {
        if (err instanceof DecisionError || err instanceof SupersedeError) {
          throw new SuggestionApplyError(err.message);
        }
        throw err;
      }
      resultTargetId = suggestion.targetId;
    } else if (suggestion.changeType === "replace") {
      // The work changed shape: create the new task in the old one's
      // project, then supersede the old task with it (kept, linked, notes
      // copied -- see supersedeTask). One approval, one transaction.
      const newTask = fields.newTask as { title?: unknown; nextAction?: unknown; description?: unknown } | undefined;
      const title = typeof newTask?.title === "string" ? newTask.title.trim() : "";
      if (targetType !== "task" || !suggestion.targetId || !title) {
        throw new SuggestionApplyError("Replace suggestion is missing the task to replace or the new task's title");
      }
      const [old] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, suggestion.targetId), eq(tasks.organizationId, params.organizationId)));
      if (!old) throw new SuggestionApplyError("Task not found or not in this organization");
      if (TERMINAL_TASK_STATUSES.includes(old.status)) {
        throw new SuggestionApplyError(`Task is already ${old.status}`);
      }
      const nextAction = typeof newTask?.nextAction === "string" && newTask.nextAction.trim() ? newTask.nextAction.trim() : null;
      const now = new Date().toISOString();
      const [created] = await tx
        .insert(tasks)
        .values({
          organizationId: params.organizationId,
          projectId: old.projectId,
          title,
          description: typeof newTask?.description === "string" && newTask.description.trim() ? newTask.description.trim() : null,
          nextAction,
          owner: old.owner,
          fieldEvidence: {
            status: { asOf: now, sourceId: suggestion.sourceId },
            ...(nextAction ? { nextAction: { asOf: now, sourceId: suggestion.sourceId } } : {}),
          },
        })
        .returning({ id: tasks.id });
      try {
        await supersedeTask(tx, {
          organizationId: params.organizationId,
          taskId: old.id,
          supersededById: created.id,
          actorId: params.reviewerId,
        });
      } catch (err) {
        if (err instanceof SupersedeError) throw new SuggestionApplyError(err.message);
        throw err;
      }
      resultTargetId = old.id;
    } else if (suggestion.changeType === "question") {
      // A proposed strategic question: create it, any smaller decisions it
      // breaks a broad one into, and its links, in this one transaction.
      const diff = fields as Partial<QuestionProposal>;
      if (typeof diff.objectiveId !== "string" || typeof diff.title !== "string" || !diff.title.trim()) {
        throw new SuggestionApplyError("Question suggestion is missing its objective or title");
      }
      const ids = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
      try {
        const { question } = await applyQuestionProposal(tx, {
          organizationId: params.organizationId,
          actorId: params.reviewerId,
          sourceId: suggestion.sourceId,
          proposal: {
            objectiveId: diff.objectiveId,
            title: diff.title,
            hypothesis: typeof diff.hypothesis === "string" ? diff.hypothesis : null,
            label: typeof diff.label === "string" ? diff.label : null,
            nextAction: typeof diff.nextAction === "string" ? diff.nextAction : null,
            keyDependency: typeof diff.keyDependency === "string" ? diff.keyDependency : null,
            owner: typeof diff.owner === "string" ? diff.owner : null,
            decisionIds: ids(diff.decisionIds),
            taskIds: ids(diff.taskIds),
            projectIds: ids(diff.projectIds),
            convertDecisionId: typeof diff.convertDecisionId === "string" ? diff.convertDecisionId : null,
            newDecisions: Array.isArray(diff.newDecisions)
              ? diff.newDecisions
                  .filter((d): d is { title: string; decider: string | null } => !!d && typeof d.title === "string" && !!d.title.trim())
                  .map((d) => ({ title: d.title.trim(), decider: typeof d.decider === "string" ? d.decider : null }))
              : [],
          },
        });
        resultTargetId = question.id;
      } catch (err) {
        if (err instanceof QuestionError || err instanceof DecisionError) throw new SuggestionApplyError(err.message);
        throw err;
      }
    } else if (targetType === "relationship") {
      // Always a create (targetId is never set for a relationship draft --
      // see interpret.ts/relationshipDetection.ts, there's no single existing
      // row to "update", both endpoints live in the diff itself).
      // createRelationship already does the org-scoped existence check on
      // both sides and rejects a self-link -- translate its own error type
      // into SuggestionApplyError so a stale or malformed proposal (e.g. one
      // endpoint deleted since this was proposed) fails this one suggestion
      // gracefully instead of crashing the request, same lesson as
      // REQUIRED_CREATE_FIELDS below for the four hierarchy types.
      const diff = fields as {
        fromType?: EntityNodeType;
        fromId?: string;
        toType?: EntityNodeType;
        toId?: string;
        relationType?: RelationType;
        note?: string;
      };
      if (!diff.fromType || !diff.fromId || !diff.toType || !diff.toId || !diff.relationType) {
        throw new SuggestionApplyError("Relationship suggestion is missing a required field");
      }

      try {
        const relationship = await createRelationship(tx, {
          organizationId: params.organizationId,
          actorId: params.reviewerId,
          fromType: diff.fromType,
          fromId: diff.fromId,
          toType: diff.toType,
          toId: diff.toId,
          relationType: diff.relationType,
          note: diff.note ?? null,
        });
        resultTargetId = relationship.id;
      } catch (err) {
        if (err instanceof RelationshipError) {
          throw new SuggestionApplyError(err.message);
        }
        throw err;
      }
    } else if (targetType === "milestone" || targetType === "risk") {
      const actor = { organizationId: params.organizationId, actorId: params.reviewerId, role: params.reviewerRole ?? ("member" as const) };
      try {
        const row =
          targetType === "milestone"
            ? suggestion.targetId
              ? await updateMilestone(tx, actor, suggestion.targetId, fields)
              : await createMilestone(tx, actor, fields)
            : suggestion.targetId
              ? await updateRisk(tx, actor, suggestion.targetId, fields)
              : await createRisk(tx, actor, fields);
        resultTargetId = row.id;
      } catch (err) {
        if (err instanceof OverviewError) throw new SuggestionApplyError(err.message);
        throw err;
      }
    } else if (targetType === "decision") {
      const diff = fields as {
        title?: string;
        whyItMatters?: string;
        relevantContext?: string;
        suggestedNextStep?: string;
        decider?: string;
        stakeholders?: string[];
        dueDate?: string;
        relatedTaskId?: string;
        objectiveId?: string | null;
        recommendation?: string | null;
        impactOfDelay?: string | null;
      };
      if ("objectiveId" in fields) await assertLiveObjective(tx, params.organizationId, diff.objectiveId);

      if (suggestion.targetId === null) {
        // Delegating to createDecision (rather than a generic insert here) keeps
        // its org-scoped relatedTaskId/sourceId validation and decision.created
        // audit_log write as the single source of truth for decision creation;
        // duplicating that logic here would let this path silently drift out of
        // sync with the manual POST /api/decisions route.
        if (!diff.title || !diff.decider) {
          throw new SuggestionApplyError("Decision suggestion is missing a required title or decider");
        }

        const decision = await createDecision(tx, {
          organizationId: params.organizationId,
          actorId: params.reviewerId,
          title: diff.title,
          whyItMatters: diff.whyItMatters ?? null,
          relevantContext: diff.relevantContext ?? null,
          suggestedNextStep: diff.suggestedNextStep ?? null,
          decider: diff.decider,
          stakeholders: diff.stakeholders ?? [],
          dueDate: diff.dueDate ? new Date(diff.dueDate) : null,
          relatedTaskId: diff.relatedTaskId ?? null,
          // Cited from the suggestion's own row, not the model-authored diff --
          // ALLOWED_FIELDS deliberately excludes sourceId, since the suggestion
          // already carries the real source it came from.
          sourceId: suggestion.sourceId,
        });
        const overviewFields = Object.fromEntries(
          (["objectiveId", "recommendation", "impactOfDelay"] as const).filter((k) => k in fields).map((k) => [k, diff[k] ?? null]),
        );
        if (Object.keys(overviewFields).length > 0) await tx.update(decisions).set(overviewFields).where(eq(decisions.id, decision.id));
        resultTargetId = decision.id;
      } else {
        // A decision-shaped follow-up matched to an already-open decision (see
        // interpret.ts's decision-matching guidance) -- delegates to
        // updateDecision for the same reason the create branch delegates to
        // createDecision: org-scoped validation and its own decision.updated
        // audit_log entry stay owned by decisions/manage.ts. Only fields that
        // were actually present in the (already-whitelisted) diff are passed
        // through, so an update never blanks out decider/stakeholders/etc. that
        // simply weren't part of this change.
        const updateFields: Parameters<typeof updateDecision>[1]["fields"] = {};
        if ("title" in fields) updateFields.title = diff.title;
        if ("whyItMatters" in fields) updateFields.whyItMatters = diff.whyItMatters ?? null;
        if ("relevantContext" in fields) updateFields.relevantContext = diff.relevantContext ?? null;
        if ("suggestedNextStep" in fields) updateFields.suggestedNextStep = diff.suggestedNextStep ?? null;
        if ("decider" in fields) updateFields.decider = diff.decider;
        if ("stakeholders" in fields) updateFields.stakeholders = diff.stakeholders ?? [];
        if ("dueDate" in fields) updateFields.dueDate = diff.dueDate ? new Date(diff.dueDate) : null;
        if ("relatedTaskId" in fields) updateFields.relatedTaskId = diff.relatedTaskId ?? null;
        if ("objectiveId" in fields) updateFields.objectiveId = diff.objectiveId ?? null;
        if ("recommendation" in fields) updateFields.recommendation = diff.recommendation ?? null;
        if ("impactOfDelay" in fields) updateFields.impactOfDelay = diff.impactOfDelay ?? null;

        const decision = await updateDecision(tx, {
          organizationId: params.organizationId,
          decisionId: suggestion.targetId,
          actorId: params.reviewerId,
          fields: updateFields,
        });
        resultTargetId = decision.id;
      }
    } else if (targetType === "question") {
      throw new SuggestionApplyError("A question suggestion must propose a new question");
    } else {
      const table = TABLE_BY_TARGET_TYPE[targetType];

      // The destination: a new one the reviewer named (created now, in this
      // same transaction), or an existing one, which must be a live record
      // in this organization.
      if (targetType in PARENT_OF) {
        const parent = PARENT_OF[targetType as ChildLevel];
        const np = isMovable(targetType, suggestion.changeType) ? parseNewParent((suggestion.proposedDiff as Record<string, unknown>).newParent) : null;
        if (np) {
          fields[parent.field] = await findOrCreateParent(tx, { ...params, suggestionId: suggestion.id }, parent.level, np);
        } else if (parent.field in fields) {
          await assertLiveInOrg(tx, params.organizationId, parent.level, fields[parent.field], parent.level);
        }
      }

      // Only tasks track fieldEvidence (see schema.ts) -- build the patch for
      // whichever tracked fields this diff actually touches, so an
      // operational_update that only sets status doesn't disturb the
      // latestUpdate/nextAction/owner evidence already on record.
      let evidencePatch: Record<string, { asOf: string; sourceId: string }> | null = null;
      if (targetType === "task") normalizeTaskDates(fields as Record<string, unknown>);
      if (targetType === "task" && suggestion.targetId && suggestion.changeType !== "cleanup") {
        // Chronology at approval time, not just at ingestion: an older
        // source approved after a newer one (e.g. an August note approved
        // after September evidence) must not replace the newer value. Those
        // fields are held back and recorded as conflicts on the suggestion.
        const [current] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, suggestion.targetId), eq(tasks.organizationId, params.organizationId)));
        const evidence = (current?.fieldEvidence ?? {}) as Record<string, { asOf?: string } | undefined>;
        const [source] = await tx.select({ receivedAt: sources.receivedAt }).from(sources).where(eq(sources.id, suggestion.sourceId));
        const thisAsOf = (source?.receivedAt ?? suggestion.createdAt).getTime();
        for (const key of TRACKED_EVIDENCE_FIELDS) {
          const known = evidence[key]?.asOf;
          if (!(key in fields) || !known || new Date(known).getTime() <= thisAsOf) continue;
          staleConflicts.push({
            field: key,
            proposedValue: fields[key],
            proposedSourceId: suggestion.sourceId,
            proposedAsOf: new Date(thisAsOf).toISOString(),
            currentValue: current ? ((current as Record<string, unknown>)[key] ?? null) : null,
            currentAsOf: known,
          });
          delete (fields as Record<string, unknown>)[key];
        }
        if (staleConflicts.length > 0 && Object.keys(fields).length === 0) {
          const newest = staleConflicts.map((c) => c.currentAsOf.slice(0, 10)).sort().at(-1);
          throw new SuggestionApplyError(
            `Pulse already has newer information for ${staleConflicts.map((c) => c.field).join(", ")} (from ${newest}); this update is from ${new Date(thisAsOf).toISOString().slice(0, 10)}. Reject it, or edit it to keep only what is still new.`,
          );
        }
      }
      if (targetType === "task") {
        const trackedKeys: string[] = TRACKED_EVIDENCE_FIELDS.filter((key) => key in fields);
        if (suggestion.changeType === "cleanup" && suggestion.targetId) {
          // A person just looked at this record: its status is confirmed as
          // of now, and approving a bare "still active" confirms the next
          // action too, which is what clears the stale flags.
          const [current] = await tx
            .select({ status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.id, suggestion.targetId), eq(tasks.organizationId, params.organizationId)));
          if (current && TERMINAL_TASK_STATUSES.includes(current.status)) {
            throw new SuggestionApplyError(`Task is already ${current.status}`);
          }
          if (!trackedKeys.includes("status")) trackedKeys.push("status");
          if (Object.keys(fields).length === 0) trackedKeys.push("nextAction");
        }
        if (trackedKeys.length > 0) {
          const [source] = await tx
            .select({ receivedAt: sources.receivedAt })
            .from(sources)
            .where(eq(sources.id, suggestion.sourceId));
          const asOf = (source?.receivedAt ?? suggestion.createdAt).toISOString();
          evidencePatch = {};
          for (const key of trackedKeys) {
            evidencePatch[key] = { asOf, sourceId: suggestion.sourceId };
          }
        }
      }

      // A health change on an outcome is an assessment: it needs a reason,
      // is stamped with who approved it and when, and goes into the history.
      let healthChange: { health: ObjectiveHealth; rationale: string | null; by: string } | null = null;
      if (targetType === "objective") {
        if ("displayOrder" in fields) {
          const n = fields.displayOrder === null ? null : Number(fields.displayOrder);
          if (n !== null && !Number.isInteger(n)) throw new SuggestionApplyError("Display order must be a whole number");
          fields.displayOrder = n;
        }
        if ("health" in fields) {
          const health = fields.health as ObjectiveHealth;
          if (!objectiveHealthEnum.enumValues.includes(health)) throw new SuggestionApplyError(`Health must be one of: ${objectiveHealthEnum.enumValues.join(", ")}`);
          const rationale = typeof fields.healthRationale === "string" && fields.healthRationale.trim() ? fields.healthRationale.trim() : null;
          if (health !== "not_assessed" && !rationale) throw new SuggestionApplyError("A health assessment needs a one-line reason");
          const [me] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, params.reviewerId));
          healthChange = { health, rationale, by: me?.name || me?.email || "Reviewer" };
          fields.healthRationale = rationale;
          fields.healthAssessedAt = new Date();
          fields.healthAssessedBy = healthChange.by;
        }
      }

      if (suggestion.targetId) {
        const setClause: Record<string, unknown> = { ...fields, updatedAt: new Date() };
        if (evidencePatch) {
          // Shallow-merge into whatever evidence already exists (jsonb ||
          // overwrites only the top-level keys present on the right side),
          // computed server-side in the same update rather than a separate
          // read-then-write.
          setClause.fieldEvidence = sql`COALESCE(${tasks.fieldEvidence}, '{}'::jsonb) || ${JSON.stringify(evidencePatch)}::jsonb`;
        }

        const [updated] = await tx
          .update(table)
          .set(setClause as never)
          .where(and(eq(table.id, suggestion.targetId), eq(table.organizationId, params.organizationId)))
          .returning({ id: table.id });

        if (!updated) {
          throw new SuggestionApplyError("Target row not found or not in this organization");
        }
        resultTargetId = updated.id;
        if (healthChange) {
          await tx.insert(objectiveHealthHistory).values({
            organizationId: params.organizationId,
            objectiveId: updated.id,
            health: healthChange.health,
            rationale: healthChange.rationale,
            assessedBy: healthChange.by,
            source: "review",
          });
        }
      } else {
        const missing = REQUIRED_CREATE_FIELDS[targetType].filter((key) => !(key in fields));
        if (missing.length > 0) {
          throw new SuggestionApplyError(
            `Cannot create a new ${targetType}: missing required field(s) ${missing.join(", ")}`,
          );
        }

        const insertValues: Record<string, unknown> = { ...fields, organizationId: params.organizationId };
        if (evidencePatch) {
          insertValues.fieldEvidence = evidencePatch;
        }

        const [created] = await tx
          .insert(table)
          .values(insertValues as never)
          .returning({ id: table.id });
        resultTargetId = created.id;
      }
    }

    const [updatedSuggestion] = await tx
      .update(suggestions)
      .set({
        status: "approved",
        ...(staleConflicts.length > 0 ? { conflicts: [...((suggestion.conflicts as unknown[] | null) ?? []), ...staleConflicts] } : {}),
        targetId: resultTargetId,
        reviewedBy: params.reviewerId,
        reviewedAt: new Date(),
      })
      .where(eq(suggestions.id, suggestion.id))
      .returning();

    // createDecision/updateDecision each already write their own
    // decision.created/decision.updated audit_log entry; logging
    // suggestion.approved here too would double the audit trail for one
    // approval, so this generic entry is skipped for the decision branch.
    if (targetType !== "decision") {
      await tx.insert(auditLog).values({
        organizationId: params.organizationId,
        actorId: params.reviewerId,
        action: "suggestion.approved",
        entityType: targetType,
        entityId: resultTargetId,
        details: { suggestionId: suggestion.id, appliedFields: fields },
      });
    }

    return updatedSuggestion;
  });
}

interface EditParams {
  organizationId: string;
  suggestionId: string;
  actorId: string;
  diff: Record<string, unknown>;
}

// Merges a reviewer's partial edit into the existing proposed_diff (the reviewer
// need not resend the whole thing) and re-runs it through pickAllowedFields, so an
// edit is exactly as constrained as the AI's own output was. Does not touch
// reviewedBy/reviewedAt -- an edit is a draft change, not a review decision.
export async function editSuggestion(db: Database, params: EditParams) {
  return db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.id, params.suggestionId), eq(suggestions.organizationId, params.organizationId)));

    if (!suggestion) {
      throw new SuggestionApplyError("Suggestion not found");
    }
    if (suggestion.status !== "pending" && suggestion.status !== "edited") {
      throw new SuggestionApplyError(`Suggestion is already ${suggestion.status}`);
    }

    const targetType = suggestion.targetType as keyof typeof TABLE_BY_TARGET_TYPE;
    const merged = { ...(suggestion.proposedDiff as Record<string, unknown>), ...params.diff };
    const sanitized = pickAllowedFields(targetType, suggestion.changeType, merged);

    // "Move to": either an existing destination (checked now, so a bad pick
    // fails here rather than at approval) or a new one, never both.
    if (isMovable(targetType, suggestion.changeType)) {
      const parent = PARENT_OF[targetType];
      if (parent.field in params.diff) {
        await assertLiveInOrg(tx, params.organizationId, parent.level, params.diff[parent.field], parent.level);
      } else if ("newParent" in params.diff && params.diff.newParent !== null) {
        const np = parseNewParent(params.diff.newParent);
        if (!np) throw new SuggestionApplyError(`Give the new ${parent.level} a name`);
        if (parent.level !== "objective") {
          const grand = PARENT_OF[parent.level];
          await assertLiveInOrg(tx, params.organizationId, grand.level, np.parentId, `${grand.level} for the new ${parent.level}`);
        }
        sanitized.newParent = np;
        delete sanitized[parent.field];
      } else if (!("newParent" in params.diff)) {
        const kept = parseNewParent((suggestion.proposedDiff as Record<string, unknown>).newParent);
        if (kept) sanitized.newParent = kept;
      }
    }

    const [updatedSuggestion] = await tx
      .update(suggestions)
      .set({ status: "edited", proposedDiff: sanitized })
      .where(eq(suggestions.id, suggestion.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "suggestion.edited",
      entityType: targetType,
      entityId: suggestion.targetId,
      details: { suggestionId: suggestion.id, editedFields: params.diff },
    });

    return updatedSuggestion;
  });
}

export async function rejectSuggestion(db: Database, params: ApplyParams) {
  return db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.id, params.suggestionId), eq(suggestions.organizationId, params.organizationId)));

    if (!suggestion) {
      throw new SuggestionApplyError("Suggestion not found");
    }
    if (suggestion.status !== "pending" && suggestion.status !== "edited") {
      throw new SuggestionApplyError(`Suggestion is already ${suggestion.status}`);
    }

    const [updatedSuggestion] = await tx
      .update(suggestions)
      .set({ status: "rejected", reviewedBy: params.reviewerId, reviewedAt: new Date() })
      .where(eq(suggestions.id, suggestion.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.reviewerId,
      action: "suggestion.rejected",
      entityType: suggestion.targetType,
      entityId: suggestion.targetId,
      details: { suggestionId: suggestion.id },
    });

    return updatedSuggestion;
  });
}
