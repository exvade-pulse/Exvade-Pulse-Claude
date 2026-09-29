import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { decisions, LIVE_DECISION_STATUSES, sources, suggestions, tasks, TERMINAL_TASK_STATUSES, type UserRole } from "../db/schema.js";
import { visibilityFilter } from "../access/visibility.js";
import { loadCompanyMapTree } from "../routes/companyMap.js";
import { describeSuggestions } from "../suggestions/describe.js";
import type { SinceLastReview } from "./reviewChanges.js";

// The executive review: what needs a decision, what's at risk, what's
// merely old. Deterministic -- no Claude call -- and it only reports what
// Pulse records ("no due date recorded", "not recorded") rather than
// inventing deadlines or owners. Built once as structured data; the in-app
// page renders the data and the ChatGPT export renders it as text, so the
// two can never disagree.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 14;
// A record with no supporting evidence for this long is "needs
// disposition" (close, update or confirm it), not "needs attention".
export const DISPOSITION_DAYS = 90;
const RECENT_LIMIT = 50;
const REVIEW_LIMIT = 100;
const TERMINAL_STATUSES = new Set<string>(TERMINAL_TASK_STATUSES);
const RISK_STATUSES = new Set(["blocked", "needs_attention", "waiting"]);

const IMPORTANCE: Record<string, number> = { critical: 1, high: 0.8, medium: 0.5, low: 0.3 };
const URGENCY: Record<string, number> = { blocked: 1, needs_attention: 0.9, waiting: 0.6, active: 0.5 };

const SOURCE_LABEL: Record<string, string> = {
  gmail: "email",
  circleback: "meeting",
  document: "document",
  manual: "note",
  chatgpt: "ChatGPT",
};

export interface ReviewTask {
  id: string;
  title: string;
  status: string;
  objective: string;
  project: string;
  owner: string | null;
  nextAction: string | null;
  latestUpdate: string | null;
  lastEvidenceAt: string;
  daysSinceEvidence: number;
  waitingOnDecision: string | null;
  attentionScore: number;
  attentionReasons: string[];
}

export interface ReviewDecision {
  id: string;
  title: string;
  status: string;
  decider: string;
  stakeholders: string[];
  dueDate: string | null;
  daysOverdue: number | null;
  whyItMatters: string | null;
  relevantContext: string | null;
  suggestedNextStep: string | null;
  relatedTask: string | null;
}

export interface ReviewDevelopment {
  id: string;
  date: string;
  about: string;
  source: string;
  summary: string;
}

export interface ReviewPending {
  id: string;
  about: string;
  changeType: string;
  confidence: number;
  reasoning: string;
}

// A pending "contradiction" suggestion: newer information conflicts with a
// statement still recorded as current. Shown prominently until resolved in
// Review (approve the correction, edit it, or reject it as not a conflict).
export interface ReviewContradiction {
  suggestionId: string;
  recordType: string;
  recordId: string;
  recordTitle: string;
  field: string;
  olderStatement: string;
  olderDate: string | null;
  newerStatement: string;
  newerDate: string | null;
  correctedValue: string;
}

export interface ReviewInventoryProject {
  objective: string;
  objectivePriority: string;
  initiative: string;
  project: string;
  tasks: ReviewTask[];
}

export interface ExecutiveReviewData {
  generatedAt: string;
  // Filled in per viewer by the route (it depends on who's looking and when
  // they last marked it reviewed); null when they never have.
  sinceLastReview?: SinceLastReview | null;
  headline: string[];
  contradictions: ReviewContradiction[];
  decisionsNeeded: ReviewDecision[];
  deadlinePassed: ReviewDecision[];
  // Decided and still being carried out -- no call needed, worth a glance.
  decisionsInProgress: ReviewDecision[];
  risks: ReviewTask[];
  operatingActions: ReviewTask[];
  needsDisposition: ReviewTask[];
  recentDevelopments: ReviewDevelopment[];
  awaitingReview: ReviewPending[];
  awaitingReviewTotal: number;
  inventory: ReviewInventoryProject[];
  counts: { openTasks: number; blocked: number; needsAttention: number; waiting: number; openDecisions: number };
}

function daysBetween(from: Date | string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / MS_PER_DAY));
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function summarizeDiff(diff: Record<string, unknown>): string {
  return Object.entries(diff)
    .filter(([key, value]) => !key.endsWith("Id") && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${clip(Array.isArray(value) ? value.join(", ") : String(value), 160)}`)
    .join("; ");
}

// Freshness counts, but can't dominate: it's one factor of five, and even a
// month-old record keeps most of its weight. Anything past
// DISPOSITION_DAYS leaves the attention lists altogether.
function relevance(days: number): number {
  if (days <= 30) return 1;
  if (days <= 60) return 0.8;
  return 0.6;
}

export function scoreAttention(input: {
  objectivePriority: string;
  status: string;
  waitingOnDecision: boolean;
  decisionDueSoonOrOverdue: boolean;
  hasNextAction: boolean;
  daysSinceEvidence: number;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const importance = IMPORTANCE[input.objectivePriority] ?? 0.5;
  if (importance >= 0.8) reasons.push(`${input.objectivePriority}-priority objective`);

  let urgency = URGENCY[input.status] ?? 0.5;
  if (input.status !== "active") reasons.push(input.status.replace("_", " "));
  if (input.decisionDueSoonOrOverdue) {
    urgency = Math.min(1, urgency + 0.2);
    reasons.push("blocking decision is due soon or overdue");
  }

  const consequence = input.waitingOnDecision ? 1 : 0.7;
  if (input.waitingOnDecision) reasons.push("waiting on an open decision");

  const actionability = input.hasNextAction ? 1 : 0.7;
  if (!input.hasNextAction) reasons.push("no next action recorded");

  const fresh = relevance(input.daysSinceEvidence);
  if (fresh < 1) reasons.push(`no new evidence in ${input.daysSinceEvidence} days`);

  return { score: Math.round(importance * urgency * consequence * actionability * fresh * 100), reasons };
}

export async function buildExecutiveReviewData(
  organizationId: string,
  role: UserRole,
  now = new Date(),
): Promise<ExecutiveReviewData> {
  const recentSince = new Date(now.getTime() - RECENT_DAYS * MS_PER_DAY);

  const [tree, openDecisionRows, recentRows, pendingRows] = await Promise.all([
    loadCompanyMapTree(organizationId, role),
    db
      .select({
        id: decisions.id,
        title: decisions.title,
        status: decisions.status,
        decider: decisions.decider,
        stakeholders: decisions.stakeholders,
        dueDate: decisions.dueDate,
        whyItMatters: decisions.whyItMatters,
        relevantContext: decisions.relevantContext,
        suggestedNextStep: decisions.suggestedNextStep,
        relatedTaskId: decisions.relatedTaskId,
      })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, LIVE_DECISION_STATUSES), visibilityFilter(role, decisions.visibility)))
      .orderBy(sql`${decisions.dueDate} is null`, decisions.dueDate),
    // "Recent" by when the evidence is dated (the source's receivedAt), not
    // when it was imported -- a 2019 document approved yesterday isn't news.
    db
      .select({
        id: suggestions.id,
        targetType: suggestions.targetType,
        targetId: suggestions.targetId,
        changeType: suggestions.changeType,
        proposedDiff: suggestions.proposedDiff,
        sourceType: sources.type,
        receivedAt: sources.receivedAt,
      })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .where(and(eq(suggestions.organizationId, organizationId), eq(suggestions.status, "approved"), gte(sources.receivedAt, recentSince)))
      .orderBy(desc(sources.receivedAt))
      .limit(RECENT_LIMIT),
    db
      .select({
        id: suggestions.id,
        targetType: suggestions.targetType,
        targetId: suggestions.targetId,
        changeType: suggestions.changeType,
        proposedDiff: suggestions.proposedDiff,
        reasoning: suggestions.reasoning,
        confidence: suggestions.confidence,
        conflicts: suggestions.conflicts,
      })
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, organizationId), inArray(suggestions.status, ["pending", "edited"])))
      .orderBy(desc(suggestions.confidence)),
  ]);

  const decisionDue = new Map(openDecisionRows.map((d) => [d.id, d.dueDate]));
  const soon = now.getTime() + 14 * MS_PER_DAY;

  // Every open task, placed in the hierarchy and scored.
  const inventory: ReviewInventoryProject[] = [];
  const openTasks: ReviewTask[] = [];
  const taskTitleById = new Map<string, string>();
  for (const objective of tree) {
    for (const initiative of objective.initiatives) {
      for (const project of initiative.projects ?? []) {
        const projectTasks: ReviewTask[] = [];
        for (const task of project.tasks) {
          if (TERMINAL_STATUSES.has(task.status)) continue;
          const days = daysBetween(task.updatedAt, now);
          const due = task.blockingDecision ? decisionDue.get(task.blockingDecision.id) : null;
          const { score, reasons } = scoreAttention({
            objectivePriority: objective.priority,
            status: task.status,
            waitingOnDecision: task.blockingDecision !== null,
            decisionDueSoonOrOverdue: !!due && new Date(due).getTime() <= soon,
            hasNextAction: !!task.nextAction,
            daysSinceEvidence: days,
          });
          const item: ReviewTask = {
            id: task.id,
            title: task.title,
            status: task.status,
            objective: objective.title,
            project: project.title,
            owner: task.owner,
            nextAction: task.nextAction,
            latestUpdate: task.latestUpdate,
            lastEvidenceAt: new Date(task.updatedAt).toISOString(),
            daysSinceEvidence: days,
            waitingOnDecision: task.blockingDecision?.title ?? null,
            attentionScore: score,
            attentionReasons: reasons,
          };
          projectTasks.push(item);
          openTasks.push(item);
          taskTitleById.set(task.id, task.title);
        }
        if (projectTasks.length > 0) {
          inventory.push({
            objective: objective.title,
            objectivePriority: objective.priority,
            initiative: initiative.title,
            project: project.title,
            tasks: projectTasks.sort((a, b) => b.attentionScore - a.attentionScore || a.title.localeCompare(b.title)),
          });
        }
      }
    }
  }

  const byScore = (a: ReviewTask, b: ReviewTask) => b.attentionScore - a.attentionScore || a.title.localeCompare(b.title);
  const needsDisposition = openTasks
    .filter((t) => t.daysSinceEvidence > DISPOSITION_DAYS)
    .sort((a, b) => b.daysSinceEvidence - a.daysSinceEvidence);
  const current = openTasks.filter((t) => t.daysSinceEvidence <= DISPOSITION_DAYS);
  const risks = current.filter((t) => RISK_STATUSES.has(t.status)).sort(byScore);
  const operatingActions = current.filter((t) => t.status === "active").sort(byScore);

  const toDecision = (d: (typeof openDecisionRows)[number]): ReviewDecision => {
    const overdue = d.dueDate && new Date(d.dueDate).getTime() < now.getTime() ? daysBetween(d.dueDate, now) : null;
    return {
      id: d.id,
      title: d.title,
      status: d.status,
      decider: d.decider,
      stakeholders: d.stakeholders,
      dueDate: d.dueDate ? new Date(d.dueDate).toISOString() : null,
      daysOverdue: overdue,
      whyItMatters: d.whyItMatters,
      relevantContext: d.relevantContext,
      suggestedNextStep: d.suggestedNextStep,
      relatedTask: d.relatedTaskId ? taskTitleById.get(d.relatedTaskId) ?? null : null,
    };
  };
  const allDecisions = openDecisionRows.map(toDecision);
  const undecided = allDecisions.filter((d) => d.status !== "action_in_progress");
  // A decision already being carried out isn't "overdue": its deadline was
  // for the call, and the call was made.
  const decisionsInProgress = allDecisions.filter((d) => d.status === "action_in_progress").map((d) => ({ ...d, daysOverdue: null }));
  const deadlinePassed = undecided.filter((d) => d.daysOverdue !== null);
  const decisionsNeeded = undecided.filter((d) => d.daysOverdue === null);

  // A member's review must not leak a restricted task or decision through
  // the review/recent sections either, only the ones they can see.
  const visibleTaskIds = new Set<string>();
  if (role !== "admin") {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.organizationId, organizationId), visibilityFilter(role, tasks.visibility)));
    for (const row of rows) visibleTaskIds.add(row.id);
  }
  const visibleDecisionIds = new Set(openDecisionRows.map((d) => d.id));
  const canSee = (row: { targetType: string; targetId: string | null; proposedDiff: unknown }): boolean => {
    if (role === "admin") return true;
    const ids: Array<[string, unknown]> = [];
    if (row.targetType === "relationship") {
      const diff = row.proposedDiff as Record<string, unknown>;
      ids.push([String(diff.fromType), diff.fromId], [String(diff.toType), diff.toId]);
    } else if (row.targetId) {
      ids.push([row.targetType, row.targetId]);
    }
    return ids.every(([type, id]) => {
      if (type === "task") return visibleTaskIds.has(String(id));
      if (type === "decision") return visibleDecisionIds.has(String(id));
      return true;
    });
  };
  const recent = recentRows.filter(canSee);
  const pending = pendingRows.filter(canSee);
  const shownPending = pending.slice(0, REVIEW_LIMIT);
  const contradictionRows = pending.filter((row) => row.changeType === "contradiction" && row.targetId);
  const about = await describeSuggestions(db, organizationId, [...recent, ...shownPending, ...contradictionRows]);
  const contradictions: ReviewContradiction[] = contradictionRows.flatMap((row) => {
    const detail = ((row.conflicts ?? []) as Array<Record<string, unknown>>).find((c) => c.kind === "contradiction");
    if (!detail) return [];
    const field = String(detail.field);
    return [
      {
        suggestionId: row.id,
        recordType: row.targetType,
        recordId: row.targetId!,
        recordTitle: about.get(row.id) ?? "(unknown)",
        field,
        olderStatement: String(detail.olderStatement),
        olderDate: (detail.olderDate as string | null) ?? null,
        newerStatement: String(detail.newerStatement),
        newerDate: (detail.newerDate as string | null) ?? null,
        correctedValue: String((row.proposedDiff as Record<string, unknown>)[field] ?? ""),
      },
    ];
  });

  const counts = {
    openTasks: openTasks.length,
    blocked: openTasks.filter((t) => t.status === "blocked").length,
    needsAttention: openTasks.filter((t) => t.status === "needs_attention").length,
    waiting: openTasks.filter((t) => t.status === "waiting").length,
    openDecisions: undecided.length,
  };

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const headline: string[] = [];
  if (decisionsNeeded.length > 0) headline.push(`${plural(decisionsNeeded.length, "decision needs", "decisions need")} a call`);
  if (deadlinePassed.length > 0) {
    headline.push(`${plural(deadlinePassed.length, "decision is", "decisions are")} past deadline with no recorded outcome — confirm what happened`);
  }
  if (contradictions.length > 0) {
    headline.push(
      `${plural(contradictions.length, "conflict", "conflicts")}: newer information contradicts what's recorded — resolve before relying on ${contradictions.length === 1 ? "it" : "them"}`,
    );
  }
  if (risks.length > 0) headline.push(`${plural(risks.length, "item is", "items are")} blocked, waiting or flagged for attention`);
  if (needsDisposition.length > 0) {
    headline.push(`${plural(needsDisposition.length, "old record needs", "old records need")} disposition (no evidence in ${DISPOSITION_DAYS}+ days) — close, update or confirm; not urgent`);
  }
  if (pending.length > 0) headline.push(`${plural(pending.length, "suggested change is", "suggested changes are")} waiting in Review`);
  if (headline.length === 0) headline.push("Nothing needs a decision or is blocked right now.");

  return {
    generatedAt: now.toISOString(),
    headline,
    contradictions,
    decisionsNeeded,
    deadlinePassed,
    decisionsInProgress,
    risks,
    operatingActions,
    needsDisposition,
    recentDevelopments: recent.map((row) => ({
      id: row.id,
      date: new Date(row.receivedAt).toISOString(),
      about: about.get(row.id) ?? "(unknown)",
      source: SOURCE_LABEL[row.sourceType] ?? row.sourceType,
      // A relationship's "about" line already says everything its diff would.
      summary: row.targetType === "relationship" ? "" : summarizeDiff(row.proposedDiff as Record<string, unknown>),
    })),
    awaitingReview: shownPending.map((row) => ({
      id: row.id,
      about: about.get(row.id) ?? "(unknown)",
      changeType: row.changeType,
      confidence: row.confidence,
      reasoning: row.reasoning,
    })),
    awaitingReviewTotal: pending.length,
    inventory,
    counts,
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function statusLabel(status: string): string {
  return status.replace("_", " ").toUpperCase();
}

function taskLines(t: ReviewTask, withPath: boolean): string[] {
  const head = `- [${statusLabel(t.status)}] ${t.title}${withPath ? ` (${t.objective} › ${t.project})` : ""}`;
  const details = [`Owner: ${t.owner ?? "not recorded"}`, `Last evidence: ${formatDate(t.lastEvidenceAt)}`];
  if (t.waitingOnDecision) details.push(`Waiting on decision: ${t.waitingOnDecision}`);
  if (t.nextAction) details.push(`Next: ${clip(t.nextAction, 200)}`);
  return [head, `    ${details.join(" | ")}`];
}

function decisionLines(d: ReviewDecision): string[] {
  const due = d.dueDate ? `due ${formatDate(d.dueDate)}` : "no due date recorded";
  const state = d.status === "pending_info" ? " | waiting on more information" : "";
  const lines = [`- ${d.title}`, `    Decider: ${d.decider} | ${due}${state}`];
  if (d.stakeholders.length > 0) lines.push(`    Stakeholders: ${d.stakeholders.join(", ")}`);
  if (d.whyItMatters) lines.push(`    Why it matters: ${clip(d.whyItMatters, 500)}`);
  if (d.relevantContext) lines.push(`    Context: ${clip(d.relevantContext, 500)}`);
  if (d.suggestedNextStep) lines.push(`    Suggested next step: ${clip(d.suggestedNextStep, 300)}`);
  if (d.relatedTask) lines.push(`    Related task: ${d.relatedTask}`);
  return lines;
}

export function renderExecutiveReviewText(data: ExecutiveReviewData): string {
  const lines: string[] = [
    "EXVADE PULSE — EXECUTIVE REVIEW",
    `Generated: ${data.generatedAt.slice(0, 16).replace("T", " ")} UTC`,
    "",
    "This is a snapshot of Exvade Bioscience's operations tracker (Pulse). Please review it using what you know about Exvade: what should I focus on, what am I missing, which decisions need attention, and what should happen next? Anything I paste back into Pulse goes to a review queue for approval before it changes anything.",
    "Note: Pulse doesn't record due dates on tasks (only on decisions). Owners are shown where known. \"Last evidence\" is the date of the newest source backing a record, not when it was imported.",
    "",
    "THIS WEEK",
    ...data.headline.map((h) => `- ${h}`),
  ];

  if (data.sinceLastReview) {
    const { lastReviewedAt, changes } = data.sinceLastReview;
    lines.push("", `SINCE MY LAST REVIEW (${formatDate(lastReviewedAt)})`);
    if (changes.length === 0) lines.push("- Nothing material has changed.");
    for (const c of changes.slice(0, 10)) lines.push(`- ${c.title}: ${c.detail}`);
    if (changes.length > 10) lines.push(`- …and ${changes.length - 10} smaller changes.`);
  }

  if (data.contradictions.length > 0) {
    lines.push("", "CONFLICTS DETECTED — newer information contradicts what's recorded; resolve before relying on these");
    for (const c of data.contradictions) {
      lines.push(
        `- ${c.recordTitle} (${c.field})`,
        `    Recorded${c.olderDate ? ` (${formatDate(c.olderDate)})` : ""}: ${clip(c.olderStatement, 300)}`,
        `    Newer${c.newerDate ? ` (${formatDate(c.newerDate)})` : ""}: ${clip(c.newerStatement, 300)}`,
        `    Proposed correction, awaiting approval: ${clip(c.correctedValue, 300)}`,
      );
    }
  }

  lines.push("", "1. DECISIONS NEEDED");
  if (data.decisionsNeeded.length === 0) lines.push("- None.");
  for (const d of data.decisionsNeeded) lines.push(...decisionLines(d));

  lines.push("", "2. DEADLINE PASSED — WHAT ACTUALLY HAPPENED?", "Still marked open after their due date; treat as unknown status, not as future decisions.");
  if (data.deadlinePassed.length === 0) lines.push("- None.");
  for (const d of data.deadlinePassed) {
    lines.push(...decisionLines(d));
    lines.push(`    ${d.daysOverdue} days past due with no recorded outcome.`);
  }

  if (data.decisionsInProgress.length > 0) {
    lines.push("", "Decided and being carried out:");
    for (const d of data.decisionsInProgress) lines.push(`- ${d.title} (decider: ${d.decider})`);
  }

  lines.push("", "3. RISKS & BLOCKERS (blocked, waiting or flagged; ordered by attention)");
  if (data.risks.length === 0) lines.push("- None.");
  for (const t of data.risks) lines.push(...taskLines(t, true));

  lines.push("", "4. OPERATING ACTIONS (active work, ordered by attention)");
  if (data.operatingActions.length === 0) lines.push("- None.");
  for (const t of data.operatingActions) lines.push(...taskLines(t, true));

  lines.push(
    "",
    `5. NEEDS DISPOSITION (${data.needsDisposition.length} open records with no supporting evidence in ${DISPOSITION_DAYS}+ days)`,
    "Probably stale rather than urgent: each should be closed, updated or confirmed still relevant.",
  );
  if (data.needsDisposition.length === 0) lines.push("- None.");
  for (const t of data.needsDisposition) {
    lines.push(`- [${statusLabel(t.status)}] ${t.title} (${t.project}) — last evidence ${formatDate(t.lastEvidenceAt)}, ${t.daysSinceEvidence} days ago`);
  }

  lines.push("", `6. RECENT DEVELOPMENTS (approved updates dated in the last ${RECENT_DAYS} days)`);
  if (data.recentDevelopments.length === 0) lines.push("- None.");
  for (const r of data.recentDevelopments) {
    lines.push(`- ${formatDate(r.date)} · ${r.about} (from ${r.source})${r.summary ? `\n    ${r.summary}` : ""}`);
  }

  const more = data.awaitingReviewTotal - data.awaitingReview.length;
  lines.push("", `7. AWAITING REVIEW IN PULSE (${data.awaitingReviewTotal} proposed changes not yet approved, highest confidence first)`);
  if (data.awaitingReview.length === 0) lines.push("- None.");
  for (const p of data.awaitingReview) {
    lines.push(`- ${p.about} — ${p.changeType.replace("_", " ")}, ${Math.round(p.confidence * 100)}% confidence`, `    Why: ${clip(p.reasoning, 240)}`);
  }
  if (more > 0) lines.push(`- …and ${more} more.`);

  lines.push("", "8. FULL OPEN-TASK INVENTORY (reference; by objective › initiative › project)");
  if (data.inventory.length === 0) lines.push("- No open tasks.");
  for (const group of data.inventory) {
    lines.push("", `${group.objective} [${group.objectivePriority} priority] › ${group.initiative} › ${group.project}`);
    for (const t of group.tasks) {
      lines.push(...taskLines(t, false));
      if (t.latestUpdate) lines.push(`    Latest: ${clip(t.latestUpdate, 300)}`);
    }
  }

  const c = data.counts;
  lines.push(
    "",
    `Reference counts: ${c.openTasks} open tasks (${c.blocked} blocked, ${c.needsAttention} need attention, ${c.waiting} waiting) · ${c.openDecisions} open decisions.`,
  );
  return lines.join("\n");
}

export async function buildExecutiveReview(organizationId: string, role: UserRole, now = new Date()): Promise<string> {
  return renderExecutiveReviewText(await buildExecutiveReviewData(organizationId, role, now));
}
