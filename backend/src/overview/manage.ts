import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database, DbOrTx } from "../db/client.js";
import {
  auditLog,
  decisions,
  initiatives,
  milestoneConfidenceEnum,
  milestoneLinks,
  milestones,
  milestoneStateEnum,
  objectiveHealthHistory,
  objectives,
  projects,
  riskEscalationEnum,
  risks,
  riskStatusEnum,
  strategicQuestions,
  tasks,
  UNDECIDED_DECISION_STATUSES,
  type UserRole,
} from "../db/schema.js";
import { updateDecision } from "../decisions/manage.js";
import { visibilityFilter } from "../access/visibility.js";

// Edits behind the Executive Overview: an outcome's rationale and order,
// milestones and what they depend on, risks, and the overview fields on a
// decision. Nothing here deletes a record -- a milestone is "dropped" and a
// risk "closed" instead -- and every change is in the audit log.

export class OverviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_OBJECTIVE = ["active", "paused"] as const;

interface Actor {
  organizationId: string;
  actorId: string;
  role: UserRole;
}

// A calendar date "YYYY-MM-DD" (or full ISO) stored at midnight UTC; null or
// "" clears it; undefined means "not given".
function day(value: unknown, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const d = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : null;
  if (!d || Number.isNaN(d.getTime())) throw new OverviewError(`${field} must be a date (YYYY-MM-DD)`);
  return d;
}

function text(value: unknown, field: string, { required = false, max = 2000 } = {}): string | null | undefined {
  if (value === undefined) return required ? (() => { throw new OverviewError(`${field} is required`); })() : undefined;
  if (value === null) {
    if (required) throw new OverviewError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new OverviewError(`${field} must be text`);
  const t = value.trim().slice(0, max);
  if (!t && required) throw new OverviewError(`${field} is required`);
  return t || null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new OverviewError(`${field} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

async function liveObjective(tx: DbOrTx, organizationId: string, id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) throw new OverviewError("Objective not found", 404);
  const [row] = await tx
    .select()
    .from(objectives)
    .where(and(eq(objectives.id, id), eq(objectives.organizationId, organizationId), inArray(objectives.status, [...LIVE_OBJECTIVE])));
  if (!row) throw new OverviewError("Objective not found", 404);
  return row;
}

async function audit(tx: DbOrTx, a: Actor, action: string, entityType: string, entityId: string, details: unknown) {
  await tx.insert(auditLog).values({ organizationId: a.organizationId, actorId: a.actorId, action, entityType, entityId, details });
}

// --- Outcomes ---------------------------------------------------------------

export async function updateOutcome(db: Database, a: Actor, objectiveId: string, body: Record<string, unknown>) {
  const fields = defined({
    rationale: text(body.rationale, "Rationale", { max: 600 }),
    owner: text(body.owner, "Owner", { max: 200 }),
    displayOrder:
      body.displayOrder === undefined ? undefined : body.displayOrder === null ? null : Number.isInteger(body.displayOrder) ? (body.displayOrder as number) : NaN,
  });
  if (Number.isNaN(fields.displayOrder)) throw new OverviewError("Display order must be a whole number");
  if (Object.keys(fields).length === 0) throw new OverviewError("Nothing to change");
  return db.transaction(async (tx) => {
    await liveObjective(tx, a.organizationId, objectiveId);
    const [row] = await tx.update(objectives).set({ ...fields, updatedAt: new Date() }).where(eq(objectives.id, objectiveId)).returning();
    await audit(tx, a, "objective.overview_updated", "objective", objectiveId, fields);
    return row;
  });
}

// --- Milestones -------------------------------------------------------------

const CONFIDENCE = milestoneConfidenceEnum.enumValues;
const STATE = milestoneStateEnum.enumValues;

export async function createMilestone(db: Database, a: Actor, body: Record<string, unknown>) {
  const values = {
    title: text(body.title, "Title", { required: true, max: 300 })!,
    successCriteria: text(body.successCriteria, "Success criteria"),
    owner: text(body.owner, "Owner", { max: 200 }),
    baselineDate: day(body.baselineDate, "Baseline date"),
    forecastDate: day(body.forecastDate, "Forecast date"),
    confidence: oneOf(body.confidence, CONFIDENCE, "Confidence"),
  };
  return db.transaction(async (tx) => {
    const objective = await liveObjective(tx, a.organizationId, body.objectiveId);
    const [row] = await tx
      .insert(milestones)
      .values({ ...defined(values), title: values.title, organizationId: a.organizationId, objectiveId: objective.id })
      .returning();
    await audit(tx, a, "milestone.created", "milestone", row.id, defined(values));
    return row;
  });
}

// The baseline is the committed plan: anyone may set the first one, but
// moving it afterwards is an admin call, so a slip shows against it instead
// of quietly rewriting the plan.
export async function updateMilestone(db: Database, a: Actor, milestoneId: string, body: Record<string, unknown>) {
  const fields = defined({
    title: body.title === undefined ? undefined : (text(body.title, "Title", { required: true, max: 300 }) as string),
    successCriteria: text(body.successCriteria, "Success criteria"),
    owner: text(body.owner, "Owner", { max: 200 }),
    baselineDate: day(body.baselineDate, "Baseline date"),
    forecastDate: day(body.forecastDate, "Forecast date"),
    actualDate: day(body.actualDate, "Date achieved"),
    confidence: oneOf(body.confidence, CONFIDENCE, "Confidence"),
    state: oneOf(body.state, STATE, "State"),
  });
  if (Object.keys(fields).length === 0) throw new OverviewError("Nothing to change");
  if (!UUID.test(milestoneId)) throw new OverviewError("Milestone not found", 404);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(milestones).where(and(eq(milestones.id, milestoneId), eq(milestones.organizationId, a.organizationId)));
    if (!existing) throw new OverviewError("Milestone not found", 404);
    if ("baselineDate" in fields && existing.baselineDate && a.role !== "admin" && fields.baselineDate?.getTime() !== existing.baselineDate.getTime()) {
      throw new OverviewError("Only an admin can move a committed baseline date. Change the forecast instead.", 403);
    }
    if (fields.state === "achieved" && !fields.actualDate && !existing.actualDate) {
      const now = new Date();
      fields.actualDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    const [row] = await tx.update(milestones).set({ ...fields, updatedAt: new Date() }).where(eq(milestones.id, milestoneId)).returning();
    await audit(tx, a, "milestone.updated", "milestone", milestoneId, { before: pick(existing, Object.keys(fields)), after: fields });
    return row;
  });
}

function pick(row: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}

const LINK_TABLE = { task: tasks, decision: decisions, project: projects } as const;

export async function linkMilestone(db: Database, a: Actor, milestoneId: string, body: Record<string, unknown>) {
  const entityType = oneOf(body.entityType, ["task", "decision", "project"] as const, "Link type");
  const entityId = body.entityId;
  if (!entityType || typeof entityId !== "string" || !UUID.test(entityId)) throw new OverviewError("Choose a task, decision or project to link");
  if (!UUID.test(milestoneId)) throw new OverviewError("Milestone not found", 404);
  return db.transaction(async (tx) => {
    const [m] = await tx.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.id, milestoneId), eq(milestones.organizationId, a.organizationId)));
    if (!m) throw new OverviewError("Milestone not found", 404);
    const table = LINK_TABLE[entityType];
    const [target] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, entityId), eq(table.organizationId, a.organizationId)));
    if (!target) throw new OverviewError(`That ${entityType} wasn't found`, 404);
    await tx.insert(milestoneLinks).values({ organizationId: a.organizationId, milestoneId, entityType, entityId }).onConflictDoNothing();
    await audit(tx, a, "milestone.linked", "milestone", milestoneId, { entityType, entityId });
  });
}

// Removes the link only; the linked record is untouched.
export async function unlinkMilestone(db: Database, a: Actor, milestoneId: string, linkId: string) {
  if (!UUID.test(milestoneId) || !UUID.test(linkId)) throw new OverviewError("Link not found", 404);
  return db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(milestoneLinks)
      .where(and(eq(milestoneLinks.id, linkId), eq(milestoneLinks.milestoneId, milestoneId), eq(milestoneLinks.organizationId, a.organizationId)))
      .returning();
    if (!gone) throw new OverviewError("Link not found", 404);
    await audit(tx, a, "milestone.unlinked", "milestone", milestoneId, { entityType: gone.entityType, entityId: gone.entityId });
  });
}

// --- Risks ------------------------------------------------------------------

async function milestoneOf(tx: DbOrTx, organizationId: string, objectiveId: string, id: unknown): Promise<string | null | undefined> {
  if (id === undefined) return undefined;
  if (id === null || id === "") return null;
  if (typeof id !== "string" || !UUID.test(id)) throw new OverviewError("Milestone not found", 404);
  const [m] = await tx
    .select({ id: milestones.id })
    .from(milestones)
    .where(and(eq(milestones.id, id), eq(milestones.organizationId, organizationId), eq(milestones.objectiveId, objectiveId)));
  if (!m) throw new OverviewError("That milestone isn't part of this outcome", 404);
  return m.id;
}

function riskFields(body: Record<string, unknown>) {
  return {
    impact: text(body.impact, "Impact"),
    likelihood: text(body.likelihood, "Likelihood", { max: 200 }),
    mitigation: text(body.mitigation, "Mitigation"),
    owner: text(body.owner, "Owner", { max: 200 }),
    nextReviewAt: day(body.nextReviewAt, "Next review"),
    escalation: oneOf(body.escalation, riskEscalationEnum.enumValues, "Escalation"),
  };
}

export async function createRisk(db: Database, a: Actor, body: Record<string, unknown>) {
  const title = text(body.title, "Title", { required: true, max: 300 })!;
  const fields = riskFields(body);
  return db.transaction(async (tx) => {
    const objective = await liveObjective(tx, a.organizationId, body.objectiveId);
    const milestoneId = await milestoneOf(tx, a.organizationId, objective.id, body.milestoneId);
    const values = defined({ ...fields, milestoneId });
    const [row] = await tx.insert(risks).values({ ...values, title, organizationId: a.organizationId, objectiveId: objective.id }).returning();
    await audit(tx, a, "risk.created", "risk", row.id, { title, ...values });
    return row;
  });
}

export async function updateRisk(db: Database, a: Actor, riskId: string, body: Record<string, unknown>) {
  if (!UUID.test(riskId)) throw new OverviewError("Risk not found", 404);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(risks).where(and(eq(risks.id, riskId), eq(risks.organizationId, a.organizationId)));
    if (!existing) throw new OverviewError("Risk not found", 404);
    const fields = defined({
      title: body.title === undefined ? undefined : (text(body.title, "Title", { required: true, max: 300 }) as string),
      ...riskFields(body),
      status: oneOf(body.status, riskStatusEnum.enumValues, "Status"),
      milestoneId: await milestoneOf(tx, a.organizationId, existing.objectiveId, body.milestoneId),
    });
    if (Object.keys(fields).length === 0) throw new OverviewError("Nothing to change");
    const [row] = await tx.update(risks).set({ ...fields, updatedAt: new Date() }).where(eq(risks.id, riskId)).returning();
    await audit(tx, a, "risk.updated", "risk", riskId, { before: pick(existing, Object.keys(fields)), after: fields });
    return row;
  });
}

// --- Decisions --------------------------------------------------------------

export async function updateDecisionForOverview(db: Database, a: Actor, decisionId: string, body: Record<string, unknown>) {
  if (!UUID.test(decisionId)) throw new OverviewError("Decision not found", 404);
  const fields = defined({
    recommendation: text(body.recommendation, "Recommendation"),
    impactOfDelay: text(body.impactOfDelay, "Impact of delay"),
    objectiveId: body.objectiveId === undefined ? undefined : body.objectiveId === null || body.objectiveId === "" ? null : String(body.objectiveId),
  });
  if (Object.keys(fields).length === 0) throw new OverviewError("Nothing to change");
  const [visible] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.id, decisionId), eq(decisions.organizationId, a.organizationId), visibilityFilter(a.role, decisions.visibility)));
  if (!visible) throw new OverviewError("Decision not found", 404);
  if (fields.objectiveId) await liveObjective(db, a.organizationId, fields.objectiveId);
  return updateDecision(db, { organizationId: a.organizationId, decisionId, actorId: a.actorId, fields });
}

// --- Outcome detail ---------------------------------------------------------

// Everything the outcome detail page shows, scoped to the viewer's
// visibility. Work is summarised (initiatives and projects with open task
// counts); the Company Map remains the place for the full list.
export async function loadOutcomeDetail(db: DbOrTx, organizationId: string, role: UserRole, objectiveId: string) {
  if (!UUID.test(objectiveId)) return null;
  const [objective] = await db.select().from(objectives).where(and(eq(objectives.id, objectiveId), eq(objectives.organizationId, organizationId)));
  if (!objective) return null;

  const [history, milestoneRows, riskRows, decisionRows, questionRows, initiativeRows] = await Promise.all([
    db.select().from(objectiveHealthHistory).where(eq(objectiveHealthHistory.objectiveId, objectiveId)).orderBy(desc(objectiveHealthHistory.assessedAt)).limit(20),
    db.select().from(milestones).where(and(eq(milestones.objectiveId, objectiveId), eq(milestones.organizationId, organizationId))).orderBy(asc(milestones.createdAt)),
    db.select().from(risks).where(and(eq(risks.objectiveId, objectiveId), eq(risks.organizationId, organizationId))).orderBy(asc(risks.createdAt)),
    db
      .select()
      .from(decisions)
      .where(and(eq(decisions.objectiveId, objectiveId), eq(decisions.organizationId, organizationId), visibilityFilter(role, decisions.visibility))),
    db.select().from(strategicQuestions).where(and(eq(strategicQuestions.objectiveId, objectiveId), eq(strategicQuestions.organizationId, organizationId))),
    db
      .select({ id: initiatives.id, title: initiatives.title, status: initiatives.status })
      .from(initiatives)
      .where(and(eq(initiatives.objectiveId, objectiveId), eq(initiatives.organizationId, organizationId), inArray(initiatives.status, [...LIVE_OBJECTIVE]))),
  ]);

  const initiativeIds = initiativeRows.map((i) => i.id);
  const projectRows = initiativeIds.length
    ? await db
        .select({ id: projects.id, title: projects.title, initiativeId: projects.initiativeId })
        .from(projects)
        .where(and(inArray(projects.initiativeId, initiativeIds), inArray(projects.status, [...LIVE_OBJECTIVE])))
    : [];
  const projectIds = projectRows.map((p) => p.id);
  const openTasks = projectIds.length
    ? await db
        .select({ id: tasks.id, title: tasks.title, status: tasks.status, projectId: tasks.projectId })
        .from(tasks)
        .where(and(inArray(tasks.projectId, projectIds), inArray(tasks.status, ["active", "waiting", "needs_attention", "blocked"]), visibilityFilter(role, tasks.visibility)))
    : [];

  // Resolve what each milestone links to, dropping anything the viewer can't see.
  const links = milestoneRows.length
    ? await db.select().from(milestoneLinks).where(inArray(milestoneLinks.milestoneId, milestoneRows.map((m) => m.id)))
    : [];
  const ids = (type: string) => links.filter((l) => l.entityType === type).map((l) => l.entityId);
  const [linkedTasks, linkedDecisions, linkedProjects] = await Promise.all([
    ids("task").length
      ? db.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(and(inArray(tasks.id, ids("task")), visibilityFilter(role, tasks.visibility)))
      : [],
    ids("decision").length
      ? db
          .select({ id: decisions.id, title: decisions.title, status: decisions.status })
          .from(decisions)
          .where(and(inArray(decisions.id, ids("decision")), visibilityFilter(role, decisions.visibility)))
      : [],
    ids("project").length ? db.select({ id: projects.id, title: projects.title, status: projects.status }).from(projects).where(inArray(projects.id, ids("project"))) : [],
  ]);
  const byKey = new Map<string, { title: string; status: string }>([
    ...linkedTasks.map((t) => [`task:${t.id}`, t] as const),
    ...linkedDecisions.map((d) => [`decision:${d.id}`, d] as const),
    ...linkedProjects.map((p) => [`project:${p.id}`, p] as const),
  ]);

  return {
    objective: {
      id: objective.id,
      title: objective.title,
      description: objective.description,
      rationale: objective.rationale,
      owner: objective.owner,
      status: objective.status,
      health: objective.health,
      healthRationale: objective.healthRationale,
      healthAssessedAt: objective.healthAssessedAt,
      healthAssessedBy: objective.healthAssessedBy,
      displayOrder: objective.displayOrder,
    },
    history,
    milestones: milestoneRows.map((m) => ({
      ...m,
      links: links
        .filter((l) => l.milestoneId === m.id && byKey.has(`${l.entityType}:${l.entityId}`))
        .map((l) => {
          const target = byKey.get(`${l.entityType}:${l.entityId}`)!;
          return { id: l.id, entityType: l.entityType, entityId: l.entityId, title: target.title, status: target.status };
        }),
    })),
    risks: riskRows,
    decisions: decisionRows.map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      decider: d.decider,
      dueDate: d.dueDate,
      recommendation: d.recommendation,
      impactOfDelay: d.impactOfDelay,
      undecided: (UNDECIDED_DECISION_STATUSES as readonly string[]).includes(d.status),
    })),
    questions: questionRows.map((q) => ({ id: q.id, title: q.title, label: q.label, status: q.status, nextAction: q.nextAction })),
    work: initiativeRows.map((i) => ({
      id: i.id,
      title: i.title,
      projects: projectRows
        .filter((p) => p.initiativeId === i.id)
        .map((p) => ({ id: p.id, title: p.title, openTasks: openTasks.filter((t) => t.projectId === p.id).length })),
    })),
    openTaskTotal: openTasks.length,
    blockedTasks: openTasks.filter((t) => t.status === "blocked").map((t) => ({ id: t.id, title: t.title })),
  };
}
