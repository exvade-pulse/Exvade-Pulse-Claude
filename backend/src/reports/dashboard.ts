import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { decisions, sources, suggestions, tasks, type UserRole } from "../db/schema.js";
import { canViewVisibility } from "../access/visibility.js";
import { describeSuggestions } from "../suggestions/describe.js";
import type { ExecutiveReviewData, ReviewDecision, ReviewQuestion, ReviewTask, ReviewWorkstream } from "./executiveReview.js";

// The executive page as an operating dashboard: a handful of priorities
// (strategic questions, or the top workstreams when there are none), what
// changed, what needs the viewer, real upcoming dates and what's stuck.
// Built on top of the review data, per viewer.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_CHANGE_WINDOW_DAYS = 14;
// Evidence older than this before the review isn't news even if it was only
// just approved (e.g. a historical import).
const STALE_EVIDENCE_GRACE_DAYS = 7;
const CHANGES_SHOWN = 6;
const DEADLINE_HORIZON_DAYS = 90;
const DEADLINE_SOON_DAYS = 14;
const MAX_PRIORITIES = 10;
const UNLINKED_SHOWN = 6;

export interface Viewer {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
}

export type DashState = "needs action" | "upcoming deadline" | "waiting" | "recently changed" | "on track" | "resolved";

export interface DashboardChange {
  // When the evidence is dated (the source), and when it was approved into
  // Pulse -- older evidence approved recently is labelled as such.
  date: string;
  approvedAt: string | null;
  about: string;
  text: string;
  recordType: string;
  recordId: string;
}

export interface DashboardPriority {
  id: string;
  kind: "question" | "workstream";
  title: string;
  // One line: the question itself, or the workstream's objective.
  objective: string;
  state: DashState;
  stateDetail: string;
  nextAction: string | null;
  // Who does the next action (may differ from the priority owner).
  nextActionOwner: string | null;
  nextActionIsMine: boolean;
  owner: string | null;
  keyDate: { label: string; date: string } | null;
  keyDependency: string | null;
  details: {
    hypothesis: string | null;
    decisions: Array<{ id: string; title: string; dueDate: string | null; overdue: boolean; decider: string }>;
    work: Array<{ id: string; title: string; status: string; project: string; nextAction: string | null; owner: string | null }>;
    recent: DashboardChange[];
  };
}

export interface DashboardItem {
  kind: "decision" | "task";
  id: string;
  title: string;
  detail: string;
  date: string | null;
  mine: boolean;
}

export interface DashboardDeadline {
  kind: "decision";
  id: string;
  title: string;
  date: string;
  daysAway: number;
  owner: string;
}

export interface Dashboard {
  since: string;
  // No open strategic questions: priorities can't be ranked yet, and the
  // page says so instead of substituting something else.
  strategySetupIncomplete: boolean;
  priorities: DashboardPriority[];
  // Active workstreams with work not under any strategic question.
  unlinkedWorkstreams: DashboardPriority[];
  // Live tasks still sitting in the Unsorted triage bucket.
  unsortedTasks: number;
  whatChanged: DashboardChange[];
  needsMe: DashboardItem[];
  upcomingDeadlines: DashboardDeadline[];
  waiting: DashboardItem[];
}

// "Sean Meehan" / sean@exvadebio.com -> ["sean", "meehan"]. An admin also
// answers for "Leadership"/"CEO" deciders.
function viewerTokens(viewer: Viewer): string[] {
  const tokens = new Set<string>();
  for (const part of `${viewer.name} ${viewer.email.split("@")[0]}`.toLowerCase().split(/[^a-z]+/)) {
    if (part.length >= 3) tokens.add(part);
  }
  if (viewer.role === "admin") {
    tokens.add("leadership");
    tokens.add("ceo");
  }
  return [...tokens];
}

function isMine(text: string | null | undefined, tokens: string[]): boolean {
  if (!text) return false;
  const words = new Set(text.toLowerCase().split(/[^a-z]+/));
  return tokens.some((t) => words.has(t));
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// A plain sentence for what an approved change said.
function changeText(changeType: string, diff: Record<string, unknown>): string | null {
  const s = (key: string) => (typeof diff[key] === "string" && (diff[key] as string).trim() ? (diff[key] as string).trim() : null);
  if (changeType === "merge" || changeType === "relationship" || changeType === "deadline_passed") return null;
  if (changeType === "question") return "Added as a strategic question";
  if (changeType === "replace") {
    const t = (diff.newTask as { title?: string } | undefined)?.title;
    return t ? `Replaced by a new task: ${t}` : null;
  }
  return (
    s("latestUpdate") ??
    s("resolution") ??
    s("relevantContext") ??
    (s("status") ? `Now ${s("status")!.replace("_", " ")}` : null) ??
    (s("nextAction") ? `Next: ${s("nextAction")}` : null) ??
    (s("suggestedNextStep") ? `Next: ${s("suggestedNextStep")}` : null) ??
    (s("title") && changeType === "new_task" ? `New task: ${s("title")}` : null) ??
    (s("title") && changeType === "decision" ? `New decision: ${s("title")}` : null) ??
    s("description")
  );
}

async function loadChanges(organizationId: string, role: UserRole, since: Date): Promise<DashboardChange[]> {
  const rows = await db
    .select({
      id: suggestions.id,
      targetType: suggestions.targetType,
      targetId: suggestions.targetId,
      changeType: suggestions.changeType,
      proposedDiff: suggestions.proposedDiff,
      reviewedAt: suggestions.reviewedAt,
      receivedAt: sources.receivedAt,
    })
    .from(suggestions)
    .innerJoin(sources, eq(sources.id, suggestions.sourceId))
    .where(
      and(
        eq(suggestions.organizationId, organizationId),
        eq(suggestions.status, "approved"),
        gte(suggestions.reviewedAt, since),
        gte(sources.receivedAt, new Date(since.getTime() - STALE_EVIDENCE_GRACE_DAYS * MS_PER_DAY)),
      ),
    )
    .orderBy(desc(sources.receivedAt))
    .limit(200);

  // A member never sees a change to a restricted task or decision.
  let hidden = new Set<string>();
  if (role !== "admin") {
    const taskIds = rows.filter((r) => r.targetType === "task" && r.targetId).map((r) => r.targetId!);
    const decisionIds = rows.filter((r) => r.targetType === "decision" && r.targetId).map((r) => r.targetId!);
    const [t, d] = await Promise.all([
      taskIds.length ? db.select({ id: tasks.id, v: tasks.visibility }).from(tasks).where(inArray(tasks.id, taskIds)) : [],
      decisionIds.length ? db.select({ id: decisions.id, v: decisions.visibility }).from(decisions).where(inArray(decisions.id, decisionIds)) : [],
    ]);
    hidden = new Set([...t, ...d].filter((r) => !canViewVisibility(role, r.v)).map((r) => r.id));
  }

  const usable = rows
    .filter((r) => r.targetId && !hidden.has(r.targetId))
    .map((r) => ({ row: r, text: changeText(r.changeType, r.proposedDiff as Record<string, unknown>) }))
    // "Now active" on its own is bookkeeping, not news.
    .filter((x): x is { row: (typeof rows)[number]; text: string } => !!x.text && x.text !== "Now active");
  const about = await describeSuggestions(db, organizationId, usable.map((x) => x.row));

  // One change per record: the newest day wins, and within a day a real
  // update beats a bare status flip ("Now active").
  const richness = (text: string) => (/^(Now |Next: )/.test(text) ? 0 : 1);
  const best = new Map<string, (typeof usable)[number]>();
  for (const item of usable) {
    const key = `${item.row.targetType}:${item.row.targetId}`;
    const current = best.get(key);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    if (
      !current ||
      day(item.row.receivedAt) > day(current.row.receivedAt) ||
      (day(item.row.receivedAt) === day(current.row.receivedAt) && richness(item.text) > richness(current.text))
    ) {
      best.set(key, item);
    }
  }
  const result: DashboardChange[] = [...best.values()]
    .sort((a, b) => b.row.receivedAt.getTime() - a.row.receivedAt.getTime())
    .map(({ row, text }) => ({
      date: row.receivedAt.toISOString(),
      approvedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      about: (about.get(row.id) ?? "").replace(/^(Cleanup|Strategic question): /, ""),
      text: clip(text, 220),
      recordType: row.targetType,
      recordId: row.targetId!,
    }));
  return result;
}

const STATE_RANK: Record<DashState, number> = {
  "needs action": 0,
  "upcoming deadline": 1,
  waiting: 2,
  "recently changed": 3,
  "on track": 4,
  resolved: 5,
};

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export async function buildDashboard(
  organizationId: string,
  data: ExecutiveReviewData,
  viewer: Viewer,
  lastReviewedAt: Date | null,
  now = new Date(),
): Promise<Dashboard> {
  const since = lastReviewedAt ?? new Date(now.getTime() - DEFAULT_CHANGE_WINDOW_DAYS * MS_PER_DAY);
  const tokens = viewerTokens(viewer);
  const allChanges = await loadChanges(organizationId, viewer.role, since);
  const changedKeys = new Set(allChanges.map((c) => `${c.recordType}:${c.recordId}`));

  const tasksById = new Map<string, ReviewTask>();
  for (const group of data.inventory) for (const t of group.tasks) tasksById.set(t.id, t);
  const allDecisions: ReviewDecision[] = [...data.decisionsNeeded, ...data.deadlinePassed, ...data.decisionsInProgress];
  const decisionsById = new Map(allDecisions.map((d) => [d.id, d]));
  const dueSoon = now.getTime() + DEADLINE_SOON_DAYS * MS_PER_DAY;
  const upcomingDate = (d: ReviewDecision) =>
    d.dueDate && new Date(d.dueDate).getTime() >= now.getTime() && d.status !== "action_in_progress" ? d.dueDate : null;

  // Priorities from strategic questions.
  const fromQuestion = (q: ReviewQuestion): DashboardPriority => {
    const work = q.taskIds.map((id) => tasksById.get(id)).filter((t): t is ReviewTask => !!t);
    const linkedDecisions = q.decisionIds.map((id) => decisionsById.get(id)).filter((d): d is ReviewDecision => !!d);
    const open = linkedDecisions.filter((d) => d.status !== "action_in_progress");
    // The question's own next action, else the call still to make, else the most
    // pressing linked task's next step -- each with whoever actually does it
    // (not the priority's owner), which is what "your next action" means.
    const decisionStep = open.find((d) => d.suggestedNextStep);
    const taskStep = work.find((t) => t.nextAction);
    const [nextAction, actionOwner] = q.nextAction
      ? [q.nextAction, q.owner]
      : decisionStep
        ? [decisionStep.suggestedNextStep, decisionStep.decider]
        : taskStep
          ? [taskStep.nextAction, taskStep.owner]
          : [null, null];
    const owner = q.owner ?? open[0]?.decider ?? mostCommon(work.map((t) => t.owner));
    const dated = open
      .map((d) => ({ d, date: upcomingDate(d) }))
      .filter((x): x is { d: ReviewDecision; date: string } => !!x.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    const keyDate = dated[0] ? { label: dated[0].d.title, date: dated[0].date } : null;
    const changed = [...q.taskIds.map((id) => `task:${id}`), ...q.decisionIds.map((id) => `decision:${id}`)].some((k) => changedKeys.has(k));
    const state: DashState =
      q.state === "resolved"
        ? "resolved"
        : q.state === "needs attention" || q.state === "decision needed"
          ? "needs action"
          : keyDate && new Date(keyDate.date).getTime() <= dueSoon
            ? "upcoming deadline"
            : q.state === "waiting"
              ? "waiting"
              : changed
                ? "recently changed"
                : "on track";
    const c = q.counts;
    const stateDetail = [
      q.openDecisions.length && `${q.openDecisions.length} open decision${q.openDecisions.length === 1 ? "" : "s"}`,
      c.blocked && `${c.blocked} blocked`,
      c.needsAttention && `${c.needsAttention} need attention`,
      c.waiting && `${c.waiting} waiting`,
      q.conflicts && `${q.conflicts} conflict${q.conflicts === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const linkedKeys = new Set([...q.taskIds.map((id) => `task:${id}`), ...q.decisionIds.map((id) => `decision:${id}`)]);
    return {
      id: q.id,
      kind: "question",
      title: q.label ?? q.title,
      objective: q.label ? q.title : q.objective,
      state,
      stateDetail,
      nextAction,
      nextActionOwner: actionOwner,
      nextActionIsMine: isMine(actionOwner, tokens),
      owner,
      keyDate,
      keyDependency: q.keyDependency ?? work.flatMap((t) => t.waitingOn)[0] ?? open.flatMap((d) => d.waitingOn)[0] ?? null,
      details: {
        hypothesis: q.hypothesis,
        decisions: open.map((d) => ({ id: d.id, title: d.title, dueDate: d.dueDate, overdue: d.daysOverdue !== null, decider: d.decider })),
        work: work.map((t) => ({ id: t.id, title: t.title, status: t.status, project: t.project, nextAction: t.nextAction, owner: t.owner })),
        recent: allChanges.filter((ch) => linkedKeys.has(`${ch.recordType}:${ch.recordId}`)).slice(0, 5),
      },
    };
  };

  // Fallback priorities from the busiest workstreams not already covered.
  const fromWorkstream = (w: ReviewWorkstream): DashboardPriority => {

    const owner = mostCommon(w.tasks.map((t) => t.owner));
    const step = w.tasks.find((t) => t.nextAction);
    const changed = w.tasks.some((t) => changedKeys.has(`task:${t.id}`));
    const c = w.counts;
    return {
      id: `workstream:${w.project}`,
      kind: "workstream",
      title: w.project,
      objective: w.objective,
      state: w.state === "needs attention" ? "needs action" : w.state === "waiting" ? "waiting" : changed ? "recently changed" : "on track",
      stateDetail: [c.blocked && `${c.blocked} blocked`, c.needsAttention && `${c.needsAttention} need attention`, c.waiting && `${c.waiting} waiting`, c.active && `${c.active} active`]
        .filter(Boolean)
        .join(" · "),
      nextAction: step?.nextAction ?? null,
      nextActionOwner: step?.owner ?? null,
      nextActionIsMine: isMine(step?.owner, tokens),
      owner,
      keyDate: null,
      keyDependency: w.tasks.flatMap((t) => t.waitingOn)[0] ?? null,
      details: {
        hypothesis: null,
        decisions: [],
        work: w.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, project: t.project, nextAction: t.nextAction, owner: t.owner })),
        recent: allChanges.filter((ch) => ch.recordType === "task" && w.tasks.some((t) => t.id === ch.recordId)).slice(0, 5),
      },
    };
  };

  // Priorities are the strategic questions only. Work not under any question
  // is listed separately and never passed off as a priority; the triage
  // bucket (Unsorted) is never promoted at all.
  const priorities = data.questions
    .filter((q) => q.status === "open")
    .map(fromQuestion)
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || Number(b.nextActionIsMine) - Number(a.nextActionIsMine))
    .slice(0, MAX_PRIORITIES);
  const covered = new Set(data.questions.filter((q) => q.status === "open").flatMap((q) => q.taskIds));
  const isTriage = (w: ReviewWorkstream) => /^unsorted\b/i.test(w.project);
  const unlinkedWorkstreams = data.workstreams
    .filter((w) => !isTriage(w) && w.tasks.some((t) => !covered.has(t.id)))
    .slice(0, UNLINKED_SHOWN)
    .map(fromWorkstream);
  const unsortedTasks = data.inventory.filter((g) => /^unsorted\b/i.test(g.project)).reduce((n, g) => n + g.tasks.length, 0);

  // What changed: priority-linked and decision changes first, then the rest.
  const priorityKeys = new Set(
    data.questions.flatMap((q) => [...q.taskIds.map((id) => `task:${id}`), ...q.decisionIds.map((id) => `decision:${id}`)]),
  );
  const whatChanged = [...allChanges]
    .sort((a, b) => {
      const rank = (c: DashboardChange) => (priorityKeys.has(`${c.recordType}:${c.recordId}`) ? 0 : c.recordType === "decision" || c.recordType === "question" ? 1 : 2);
      return rank(a) - rank(b) || b.date.localeCompare(a.date);
    })
    .slice(0, CHANGES_SHOWN);

  // Needs me: decisions I decide, and my work that's stuck or has a next step.
  const needsMe: DashboardItem[] = [];
  for (const d of [...data.deadlinePassed, ...data.decisionsNeeded]) {
    if (!isMine(d.decider, tokens)) continue;
    needsMe.push({
      kind: "decision",
      id: d.id,
      title: d.title,
      detail: d.daysOverdue !== null ? `Past its ${d.dueDate ? new Date(d.dueDate).toISOString().slice(0, 10) : ""} deadline: record what happened` : d.suggestedNextStep ? `Next: ${d.suggestedNextStep}` : "Decision needed",
      date: d.daysOverdue === null ? upcomingDate(d) : null,
      mine: true,
    });
  }
  for (const t of [...data.risks, ...data.operatingActions]) {
    if (!isMine(t.owner, tokens)) continue;
    if (t.status === "active" && !t.nextAction) continue;
    needsMe.push({
      kind: "task",
      id: t.id,
      title: t.title,
      detail: t.nextAction ? `Next: ${t.nextAction}` : t.status.replace("_", " "),
      date: null,
      mine: true,
    });
  }

  const upcomingDeadlines: DashboardDeadline[] = allDecisions
    .map((d) => ({ d, date: upcomingDate(d) }))
    .filter((x): x is { d: ReviewDecision; date: string } => !!x.date && new Date(x.date).getTime() <= now.getTime() + DEADLINE_HORIZON_DAYS * MS_PER_DAY)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ d, date }) => ({
      kind: "decision" as const,
      id: d.id,
      title: d.title,
      date,
      daysAway: Math.max(0, Math.ceil((new Date(date).getTime() - now.getTime()) / MS_PER_DAY)),
      owner: d.decider,
    }));

  const waiting: DashboardItem[] = [
    ...data.risks
      .filter((t) => t.status === "blocked" || t.status === "waiting")
      .map((t) => ({
        kind: "task" as const,
        id: t.id,
        title: t.title,
        detail: [t.status === "blocked" ? "Blocked" : "Waiting", t.waitingOn.length ? `on ${t.waitingOn.join(", ")}` : null, t.owner ? `· ${t.owner}` : null]
          .filter(Boolean)
          .join(" "),
        date: null,
        mine: isMine(t.owner, tokens),
      })),
    ...allDecisions
      .filter((d) => d.status === "pending_info")
      .map((d) => ({
        kind: "decision" as const,
        id: d.id,
        title: d.title,
        detail: `Waiting on more information${d.waitingOn.length ? `: ${d.waitingOn.join(", ")}` : ""} · ${d.decider}`,
        date: null,
        mine: isMine(d.decider, tokens),
      })),
  ];

  return {
    since: since.toISOString(),
    strategySetupIncomplete: priorities.length === 0,
    priorities,
    unlinkedWorkstreams,
    unsortedTasks,
    whatChanged, needsMe: needsMe.slice(0, 8), upcomingDeadlines, waiting: waiting.slice(0, 10) };
}
