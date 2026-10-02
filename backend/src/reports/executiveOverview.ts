import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import {
  decisions,
  milestoneLinks,
  milestones,
  objectiveHealthHistory,
  objectives,
  reportingSnapshots,
  risks,
  tasks,
  type MilestoneConfidence,
  type MilestoneState,
  type ObjectiveHealth,
  type UserRole,
} from "../db/schema.js";
import { visibilityFilter } from "../access/visibility.js";

// The Executive Overview: six outcomes, what needs leadership attention,
// the roadmap, what changed since the last published review, and top risks.
// Everything here is read-only and derived; nothing is stored. Health is
// always a person's assessment -- Pulse only adds signals that may
// contradict it, never an average of task statuses.
//
// computeOverview is pure (rows in, view model out) so the ranking rules
// are tested without a database; buildExecutiveOverview loads the rows.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// An assessment older than this shows its age and "review needed".
export const STALE_AFTER_DAYS = 30;
// The first viewport shows this many attention items; the rest are counted.
export const ATTENTION_LIMIT = 3;
const DECISION_WINDOW_DAYS = 30;
const BLOCKER_WINDOW_DAYS = 90;
const MILESTONE_SOON_DAYS = 30;
const TOP_RISKS = 3;

// Decisions still waiting to be made (action_in_progress is already decided).
const UNDECIDED = ["open", "pending_info"] as const;
const LIVE_OBJECTIVE_STATUSES = ["active", "paused"] as const;
const TRIAGE = /^unsorted\b/i;

const SEVERITY: Record<Exclude<ObjectiveHealth, "not_assessed">, number> = { on_track: 0, at_risk: 1, blocked: 2 };

export interface OverviewInput {
  objectives: Array<{
    id: string;
    title: string;
    rationale: string | null;
    owner: string | null;
    health: ObjectiveHealth;
    healthRationale: string | null;
    healthAssessedAt: Date | null;
    healthAssessedBy: string | null;
    displayOrder: number | null;
    createdAt: Date;
  }>;
  history: Array<{ objectiveId: string; health: ObjectiveHealth; assessedAt: Date }>;
  milestones: Array<{
    id: string;
    objectiveId: string;
    title: string;
    owner: string | null;
    baselineDate: Date | null;
    forecastDate: Date | null;
    actualDate: Date | null;
    confidence: MilestoneConfidence;
    state: MilestoneState;
  }>;
  // Blocked tasks a milestone depends on (via milestone_links).
  milestoneBlockers: Array<{ milestoneId: string; taskId: string; taskTitle: string; owner: string | null; waitingFor: string | null }>;
  decisions: Array<{
    id: string;
    title: string;
    decider: string;
    dueDate: Date | null;
    objectiveId: string | null;
    recommendation: string | null;
    impactOfDelay: string | null;
  }>;
  risks: Array<{
    id: string;
    objectiveId: string;
    milestoneId: string | null;
    title: string;
    impact: string | null;
    mitigation: string | null;
    owner: string | null;
    escalation: "watching" | "decision_needed";
    nextReviewAt: Date | null;
  }>;
  snapshot: {
    publishedAt: Date;
    periodStart: Date;
    periodEnd: Date;
    narrative: string | null;
    summary: SnapshotSummary;
  } | null;
}

// What a published reporting snapshot records, for "what changed".
export interface SnapshotSummary {
  objectives: Array<{ id: string; title: string; health: ObjectiveHealth }>;
  milestones: Array<{ id: string; title: string; date: string | null; state: MilestoneState }>;
}

export type Trend = "improving" | "stable" | "worsening" | "no_history";

export interface OutcomeMilestone {
  id: string;
  title: string;
  date: string | null;
  confidence: MilestoneConfidence;
  daysAway: number | null;
}

export interface Outcome {
  id: string;
  title: string;
  rationale: string | null;
  owner: string | null;
  health: ObjectiveHealth;
  healthRationale: string | null;
  assessedAt: string | null;
  assessedBy: string | null;
  // Age of the assessment in days; stale once over STALE_AFTER_DAYS.
  assessmentAgeDays: number | null;
  stale: boolean;
  trend: Trend;
  // Things Pulse sees that may contradict an "on track" assessment.
  signals: string[];
  assessmentMayBeOutdated: boolean;
  // Null means no dated milestone: show "Timing not confirmed".
  nextMilestone: OutcomeMilestone | null;
  undatedMilestones: number;
  openRisks: number;
  decisionsNeeded: number;
}

export type AttentionKind = "decision" | "blocker" | "deterioration" | "assessment_outdated" | "milestone_soon";

export interface AttentionItem {
  kind: AttentionKind;
  tier: number;
  title: string;
  detail: string;
  objectiveId: string | null;
  date: string | null;
  daysAway: number | null;
  link: { type: "decision" | "task" | "objective" | "milestone"; id: string };
  // Decisions only: who decides, the recommendation, the cost of waiting.
  decider?: string;
  recommendation?: string | null;
  impactOfDelay?: string | null;
}

export interface RoadmapMilestone {
  id: string;
  objectiveId: string;
  title: string;
  owner: string | null;
  date: string | null;
  baselineDate: string | null;
  forecastDate: string | null;
  actualDate: string | null;
  confidence: MilestoneConfidence;
  state: MilestoneState;
  // Forecast later than baseline, in days.
  slipDays: number | null;
}

export interface OverviewChange {
  kind: "health" | "milestone_date" | "milestone_state";
  title: string;
  before: string | null;
  after: string | null;
  objectiveId: string | null;
}

export interface ExecutiveOverview {
  asOf: string;
  period: { publishedAt: string; periodStart: string; periodEnd: string } | null;
  narrative: string | null;
  outcomes: Outcome[];
  attention: AttentionItem[];
  attentionTotal: number;
  roadmap: { scheduled: RoadmapMilestone[]; unscheduled: RoadmapMilestone[] };
  // Null when there is no published snapshot to compare against.
  changes: OverviewChange[] | null;
  topRisks: Array<Omit<OverviewInput["risks"][number], "nextReviewAt"> & { nextReviewAt: string | null; milestoneTitle: string | null }>;
  openRiskTotal: number;
}

const dayIndex = (d: Date) => Math.floor(d.getTime() / MS_PER_DAY);
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// The date a milestone is placed at: when it happened, else the current
// forecast, else the committed baseline.
function milestoneDate(m: OverviewInput["milestones"][number]): Date | null {
  if (m.state === "achieved" && m.actualDate) return m.actualDate;
  return m.forecastDate ?? m.baselineDate;
}

function trendFor(history: OverviewInput["history"]): Trend {
  const assessed = history.filter((h) => h.health !== "not_assessed");
  if (assessed.length < 2) return "no_history";
  const [prev, last] = assessed.slice(-2) as Array<{ health: Exclude<ObjectiveHealth, "not_assessed"> }>;
  const delta = SEVERITY[last.health] - SEVERITY[prev.health];
  return delta < 0 ? "improving" : delta > 0 ? "worsening" : "stable";
}

const HEALTH_LABEL: Record<ObjectiveHealth, string> = {
  on_track: "On track",
  at_risk: "At risk",
  blocked: "Blocked",
  not_assessed: "Not assessed",
};

export function computeOverview(input: OverviewInput, now = new Date()): ExecutiveOverview {
  const today = dayIndex(now);
  const daysAway = (d: Date | null) => (d ? dayIndex(d) - today : null);

  const outcomes = [...input.objectives].sort(
    (a, b) =>
      (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const order = new Map(outcomes.map((o, i) => [o.id, i]));
  const live = input.milestones.filter((m) => m.state !== "dropped");
  const planned = live.filter((m) => m.state === "planned");
  const milestoneById = new Map(live.map((m) => [m.id, m]));
  const blockersByMilestone = new Map<string, OverviewInput["milestoneBlockers"]>();
  for (const b of input.milestoneBlockers) blockersByMilestone.set(b.milestoneId, [...(blockersByMilestone.get(b.milestoneId) ?? []), b]);

  const outcomeViews: Outcome[] = outcomes.map((o) => {
    const mine = planned.filter((m) => m.objectiveId === o.id);
    const dated = mine.filter((m) => milestoneDate(m)).sort((a, b) => milestoneDate(a)!.getTime() - milestoneDate(b)!.getTime() || a.id.localeCompare(b.id));
    const next = dated[0] ?? null;

    const signals: string[] = [];
    for (const m of dated) {
      const away = daysAway(milestoneDate(m))!;
      if (away < 0) signals.push(`Milestone "${m.title}" is past its date and not marked achieved`);
      else if (away <= BLOCKER_WINDOW_DAYS && blockersByMilestone.has(m.id)) signals.push(`Milestone "${m.title}" depends on blocked work`);
      if (m.forecastDate && m.baselineDate && dayIndex(m.forecastDate) > dayIndex(m.baselineDate)) {
        signals.push(`Milestone "${m.title}" has slipped ${dayIndex(m.forecastDate) - dayIndex(m.baselineDate)} days past its baseline`);
      }
    }
    const age = o.healthAssessedAt ? today - dayIndex(o.healthAssessedAt) : null;
    const assessed = o.health !== "not_assessed";
    return {
      id: o.id,
      title: o.title,
      rationale: o.rationale,
      owner: o.owner,
      health: o.health,
      healthRationale: o.healthRationale,
      assessedAt: o.healthAssessedAt?.toISOString() ?? null,
      assessedBy: o.healthAssessedBy,
      assessmentAgeDays: age,
      stale: assessed && (age === null || age > STALE_AFTER_DAYS),
      trend: trendFor(input.history.filter((h) => h.objectiveId === o.id).sort((a, b) => a.assessedAt.getTime() - b.assessedAt.getTime())),
      signals,
      assessmentMayBeOutdated: o.health === "on_track" && signals.length > 0,
      nextMilestone: next
        ? { id: next.id, title: next.title, date: isoDay(milestoneDate(next)), confidence: next.confidence, daysAway: daysAway(milestoneDate(next)) }
        : null,
      undatedMilestones: mine.length - dated.length,
      openRisks: input.risks.filter((r) => r.objectiveId === o.id).length,
      decisionsNeeded: input.decisions.filter((d) => d.objectiveId === o.id).length,
    };
  });
  const outcomeById = new Map(outcomeViews.map((o) => [o.id, o]));

  // --- Leadership attention, in tiers -------------------------------------
  const items: AttentionItem[] = [];
  for (const d of input.decisions) {
    const away = daysAway(d.dueDate);
    if (away === null || away > DECISION_WINDOW_DAYS) continue;
    items.push({
      kind: "decision",
      tier: 1,
      title: d.title,
      detail: away < 0 ? `Overdue by ${-away} day${away === -1 ? "" : "s"}` : away === 0 ? "Needed today" : `Needed in ${away} day${away === 1 ? "" : "s"}`,
      objectiveId: d.objectiveId,
      date: isoDay(d.dueDate),
      daysAway: away,
      link: { type: "decision", id: d.id },
      decider: d.decider,
      recommendation: d.recommendation,
      impactOfDelay: d.impactOfDelay,
    });
  }
  const blockedMilestones = new Set<string>();
  for (const m of planned) {
    const away = daysAway(milestoneDate(m));
    if (away === null || away > BLOCKER_WINDOW_DAYS) continue;
    for (const b of blockersByMilestone.get(m.id) ?? []) {
      blockedMilestones.add(m.id);
      items.push({
        kind: "blocker",
        tier: 2,
        title: `Blocked: ${b.taskTitle}`,
        detail: `Holds up "${m.title}"${b.waitingFor ? ` · waiting on ${b.waitingFor}` : ""}${b.owner ? ` · ${b.owner}` : ""}`,
        objectiveId: m.objectiveId,
        date: isoDay(milestoneDate(m)),
        daysAway: away,
        link: { type: "task", id: b.taskId },
      });
    }
  }
  if (input.snapshot) {
    const before = new Map(input.snapshot.summary.objectives.map((o) => [o.id, o.health]));
    for (const o of outcomeViews) {
      const was = before.get(o.id);
      if (!was || was === "not_assessed" || o.health === "not_assessed") continue;
      if (SEVERITY[o.health] <= SEVERITY[was]) continue;
      items.push({
        kind: "deterioration",
        tier: 3,
        title: `${o.title} is now ${HEALTH_LABEL[o.health].toLowerCase()}`,
        detail: `Was ${HEALTH_LABEL[was].toLowerCase()} at the last review${o.healthRationale ? ` · ${o.healthRationale}` : ""}`,
        objectiveId: o.id,
        date: null,
        daysAway: null,
        link: { type: "objective", id: o.id },
      });
    }
  }
  for (const o of outcomeViews) {
    if (!o.assessmentMayBeOutdated) continue;
    items.push({
      kind: "assessment_outdated",
      tier: 4,
      title: `${o.title}: "on track" may be out of date`,
      detail: o.signals[0],
      objectiveId: o.id,
      date: null,
      daysAway: null,
      link: { type: "objective", id: o.id },
    });
  }
  for (const m of planned) {
    const away = daysAway(milestoneDate(m));
    if (away === null || away > MILESTONE_SOON_DAYS || blockedMilestones.has(m.id)) continue;
    items.push({
      kind: "milestone_soon",
      tier: 5,
      title: m.title,
      detail: away < 0 ? `Was due ${-away} day${away === -1 ? "" : "s"} ago; not marked achieved` : `Due in ${away} day${away === 1 ? "" : "s"} (${m.confidence})`,
      objectiveId: m.objectiveId,
      date: isoDay(milestoneDate(m)),
      daysAway: away,
      link: { type: "milestone", id: m.id },
    });
  }
  // Tier, then soonest date (undated last), then the outcome's fixed order,
  // then id -- the same inputs always rank the same way.
  items.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.daysAway ?? Number.MAX_SAFE_INTEGER) - (b.daysAway ?? Number.MAX_SAFE_INTEGER) ||
      (order.get(a.objectiveId ?? "") ?? Number.MAX_SAFE_INTEGER) - (order.get(b.objectiveId ?? "") ?? Number.MAX_SAFE_INTEGER) ||
      a.link.id.localeCompare(b.link.id),
  );

  // --- Roadmap -------------------------------------------------------------
  const toRoadmap = (m: OverviewInput["milestones"][number]): RoadmapMilestone => ({
    id: m.id,
    objectiveId: m.objectiveId,
    title: m.title,
    owner: m.owner,
    date: isoDay(milestoneDate(m)),
    baselineDate: isoDay(m.baselineDate),
    forecastDate: isoDay(m.forecastDate),
    actualDate: isoDay(m.actualDate),
    confidence: m.confidence,
    state: m.state,
    slipDays: m.forecastDate && m.baselineDate ? dayIndex(m.forecastDate) - dayIndex(m.baselineDate) : null,
  });
  const onRoadmap = live.filter((m) => outcomeById.has(m.objectiveId));
  const scheduled = onRoadmap
    .filter((m) => milestoneDate(m))
    .sort((a, b) => milestoneDate(a)!.getTime() - milestoneDate(b)!.getTime() || a.id.localeCompare(b.id))
    .map(toRoadmap);
  const unscheduled = onRoadmap.filter((m) => !milestoneDate(m)).map(toRoadmap);

  // --- What changed since the last published review ------------------------
  let changes: OverviewChange[] | null = null;
  if (input.snapshot) {
    changes = [];
    const was = new Map(input.snapshot.summary.objectives.map((o) => [o.id, o]));
    for (const o of outcomeViews) {
      const before = was.get(o.id);
      if (before && before.health !== o.health) {
        changes.push({ kind: "health", title: o.title, before: HEALTH_LABEL[before.health], after: HEALTH_LABEL[o.health], objectiveId: o.id });
      }
    }
    const wasM = new Map(input.snapshot.summary.milestones.map((m) => [m.id, m]));
    for (const m of onRoadmap) {
      const before = wasM.get(m.id);
      if (!before) continue;
      if (before.state !== m.state) {
        changes.push({ kind: "milestone_state", title: m.title, before: before.state, after: m.state, objectiveId: m.objectiveId });
      } else if (before.date !== isoDay(milestoneDate(m))) {
        changes.push({ kind: "milestone_date", title: m.title, before: before.date, after: isoDay(milestoneDate(m)), objectiveId: m.objectiveId });
      }
    }
  }

  // --- Top risks: escalated first, then the soonest affected milestone ----
  const openRisks = input.risks.filter((r) => outcomeById.has(r.objectiveId));
  const riskDate = (r: OverviewInput["risks"][number]) => {
    const m = r.milestoneId ? milestoneById.get(r.milestoneId) : undefined;
    return daysAway(m ? milestoneDate(m) : null) ?? Number.MAX_SAFE_INTEGER;
  };
  const topRisks = [...openRisks]
    .sort(
      (a, b) =>
        (a.escalation === "decision_needed" ? 0 : 1) - (b.escalation === "decision_needed" ? 0 : 1) ||
        riskDate(a) - riskDate(b) ||
        (a.nextReviewAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.nextReviewAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, TOP_RISKS)
    .map((r) => ({
      ...r,
      nextReviewAt: isoDay(r.nextReviewAt),
      milestoneTitle: r.milestoneId ? (milestoneById.get(r.milestoneId)?.title ?? null) : null,
    }));

  return {
    asOf: now.toISOString(),
    period: input.snapshot
      ? { publishedAt: input.snapshot.publishedAt.toISOString(), periodStart: isoDay(input.snapshot.periodStart)!, periodEnd: isoDay(input.snapshot.periodEnd)! }
      : null,
    narrative: input.snapshot?.narrative ?? null,
    outcomes: outcomeViews,
    attention: items.slice(0, ATTENTION_LIMIT),
    attentionTotal: items.length,
    roadmap: { scheduled, unscheduled },
    changes,
    topRisks,
    openRiskTotal: openRisks.length,
  };
}

// Loads one organization's rows, respecting the viewer's visibility on
// decisions and tasks, and builds the overview.
export async function buildExecutiveOverview(db: DbOrTx, organizationId: string, role: UserRole, now = new Date()): Promise<ExecutiveOverview> {
  const objectiveRows = (
    await db
      .select()
      .from(objectives)
      .where(and(eq(objectives.organizationId, organizationId), inArray(objectives.status, [...LIVE_OBJECTIVE_STATUSES])))
  ).filter((o) => !TRIAGE.test(o.title));
  const ids = objectiveRows.map((o) => o.id);
  if (ids.length === 0) {
    return computeOverview({ objectives: [], history: [], milestones: [], milestoneBlockers: [], decisions: [], risks: [], snapshot: null }, now);
  }

  const [history, milestoneRows, decisionRows, riskRows, [snapshot]] = await Promise.all([
    db
      .select({ objectiveId: objectiveHealthHistory.objectiveId, health: objectiveHealthHistory.health, assessedAt: objectiveHealthHistory.assessedAt })
      .from(objectiveHealthHistory)
      .where(and(eq(objectiveHealthHistory.organizationId, organizationId), inArray(objectiveHealthHistory.objectiveId, ids))),
    db.select().from(milestones).where(and(eq(milestones.organizationId, organizationId), inArray(milestones.objectiveId, ids))),
    db
      .select()
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, [...UNDECIDED]), visibilityFilter(role, decisions.visibility))),
    db
      .select()
      .from(risks)
      .where(and(eq(risks.organizationId, organizationId), eq(risks.status, "open"), inArray(risks.objectiveId, ids))),
    db.select().from(reportingSnapshots).where(eq(reportingSnapshots.organizationId, organizationId)).orderBy(desc(reportingSnapshots.publishedAt)).limit(1),
  ]);

  const milestoneIds = milestoneRows.map((m) => m.id);
  const milestoneBlockers = milestoneIds.length
    ? await db
        .select({ milestoneId: milestoneLinks.milestoneId, taskId: tasks.id, taskTitle: tasks.title, owner: tasks.owner, waitingFor: tasks.waitingFor })
        .from(milestoneLinks)
        .innerJoin(tasks, and(eq(tasks.id, milestoneLinks.entityId), eq(tasks.organizationId, organizationId)))
        .where(
          and(
            eq(milestoneLinks.organizationId, organizationId),
            eq(milestoneLinks.entityType, "task"),
            inArray(milestoneLinks.milestoneId, milestoneIds),
            eq(tasks.status, "blocked"),
            visibilityFilter(role, tasks.visibility),
          ),
        )
        .orderBy(asc(tasks.title))
    : [];

  return computeOverview(
    {
      objectives: objectiveRows,
      history,
      milestones: milestoneRows,
      milestoneBlockers,
      decisions: decisionRows.map((d) => ({ ...d, objectiveId: d.objectiveId && ids.includes(d.objectiveId) ? d.objectiveId : null })),
      risks: riskRows,
      snapshot: snapshot ? { ...snapshot, summary: snapshot.summary as SnapshotSummary } : null,
    },
    now,
  );
}
