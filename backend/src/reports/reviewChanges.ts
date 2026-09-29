import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { executiveReviewSnapshots } from "../db/schema.js";
import type { ExecutiveReviewData } from "./executiveReview.js";

// "Since last review": a compact record of what one person's review looked
// like when they marked it reviewed, and what has materially changed since.
// Only ids, titles, sections, statuses and scores are kept -- enough to say
// what moved, not a copy of the whole review.

type DecisionBucket = "needed" | "passed" | "in_progress";
type TaskSection = "risk" | "operating" | "disposition";

export interface ReviewSnapshotSummary {
  decisions: Array<{ id: string; title: string; bucket: DecisionBucket }>;
  tasks: Array<{ id: string; title: string; status: string; section: TaskSection; score: number }>;
  // Absent on snapshots saved before contradiction tracking existed.
  contradictions?: Array<{ id: string; title: string }>;
  // Absent on snapshots saved before strategic questions existed.
  questions?: Array<{ id: string; title: string; state: string }>;
}

export type ReviewChangeKind =
  | "NEW_CONTRADICTION"
  | "BECAME_OVERDUE"
  | "NEW_DECISION"
  | "NEW_RISK"
  | "DECISION_RESOLVED"
  | "RISK_CLEARED"
  | "DECISION_IN_PROGRESS"
  | "PRIORITY_INCREASED"
  | "NEW_WORK"
  | "STATUS_CHANGED"
  | "WORK_CLOSED"
  | "PRIORITY_DECREASED"
  | "NOW_STALE"
  | "CONFLICT_RESOLVED"
  | "NEW_QUESTION"
  | "QUESTION_NEEDS_ATTENTION"
  | "QUESTION_RESOLVED"
  | "QUESTION_STATE_CHANGED";

export interface ReviewChange {
  kind: ReviewChangeKind;
  title: string;
  detail: string;
}

export interface SinceLastReview {
  lastReviewedAt: string;
  changes: ReviewChange[];
}

// Most consequential first -- the page shows the top few.
const WEIGHT: Record<ReviewChangeKind, number> = {
  NEW_CONTRADICTION: 95,
  BECAME_OVERDUE: 100,
  NEW_DECISION: 90,
  NEW_RISK: 85,
  DECISION_RESOLVED: 70,
  RISK_CLEARED: 65,
  DECISION_IN_PROGRESS: 60,
  PRIORITY_INCREASED: 50,
  NEW_WORK: 45,
  STATUS_CHANGED: 40,
  WORK_CLOSED: 38,
  PRIORITY_DECREASED: 35,
  NOW_STALE: 30,
  CONFLICT_RESOLVED: 55,
  QUESTION_NEEDS_ATTENTION: 92,
  NEW_QUESTION: 75,
  QUESTION_RESOLVED: 72,
  QUESTION_STATE_CHANGED: 42,
};

const SCORE_SHIFT = 15;

export function summarizeReview(data: ExecutiveReviewData): ReviewSnapshotSummary {
  return {
    decisions: [
      ...data.decisionsNeeded.map((d) => ({ id: d.id, title: d.title, bucket: "needed" as const })),
      ...data.deadlinePassed.map((d) => ({ id: d.id, title: d.title, bucket: "passed" as const })),
      ...data.decisionsInProgress.map((d) => ({ id: d.id, title: d.title, bucket: "in_progress" as const })),
    ],
    tasks: [
      ...data.risks.map((t) => ({ id: t.id, title: t.title, status: t.status, section: "risk" as const, score: t.attentionScore })),
      ...data.operatingActions.map((t) => ({ id: t.id, title: t.title, status: t.status, section: "operating" as const, score: t.attentionScore })),
      ...data.needsDisposition.map((t) => ({ id: t.id, title: t.title, status: t.status, section: "disposition" as const, score: t.attentionScore })),
    ],
    contradictions: data.contradictions.map((c) => ({ id: c.suggestionId, title: `${c.recordTitle} (${c.field})` })),
    questions: data.questions.map((q) => ({ id: q.id, title: q.title, state: q.state })),
  };
}

const label = (status: string) => status.replace("_", " ");

export function diffReviews(previous: ReviewSnapshotSummary, current: ReviewSnapshotSummary): ReviewChange[] {
  const changes: ReviewChange[] = [];
  const prevDecisions = new Map(previous.decisions.map((d) => [d.id, d]));
  const currDecisions = new Map(current.decisions.map((d) => [d.id, d]));

  for (const d of current.decisions) {
    const before = prevDecisions.get(d.id);
    if (!before) {
      changes.push(
        d.bucket === "in_progress"
          ? { kind: "DECISION_IN_PROGRESS", title: d.title, detail: "Decided and now being carried out" }
          : { kind: "NEW_DECISION", title: d.title, detail: d.bucket === "passed" ? "New, and already past its deadline" : "New decision needed" },
      );
    } else if (before.bucket === "needed" && d.bucket === "passed") {
      changes.push({ kind: "BECAME_OVERDUE", title: d.title, detail: "Deadline passed with no recorded outcome" });
    } else if (before.bucket !== "in_progress" && d.bucket === "in_progress") {
      changes.push({ kind: "DECISION_IN_PROGRESS", title: d.title, detail: "Decided; now being carried out" });
    }
  }
  for (const d of previous.decisions) {
    if (!currDecisions.has(d.id)) {
      changes.push({
        kind: "DECISION_RESOLVED",
        title: d.title,
        detail: d.bucket === "in_progress" ? "Closed out" : "No longer open (decided, closed or merged)",
      });
    }
  }

  const prevTasks = new Map(previous.tasks.map((t) => [t.id, t]));
  const currTasks = new Map(current.tasks.map((t) => [t.id, t]));
  for (const t of current.tasks) {
    const before = prevTasks.get(t.id);
    if (!before) {
      if (t.section === "risk") changes.push({ kind: "NEW_RISK", title: t.title, detail: `New and ${label(t.status)}` });
      else if (t.section === "operating") changes.push({ kind: "NEW_WORK", title: t.title, detail: "New active work" });
      continue;
    }
    if (t.section === "risk" && before.section !== "risk") {
      changes.push({ kind: "NEW_RISK", title: t.title, detail: `Now ${label(t.status)} (was ${label(before.status)})` });
    } else if (before.section === "risk" && t.section !== "risk") {
      changes.push(
        t.section === "disposition"
          ? { kind: "NOW_STALE", title: t.title, detail: `Still ${label(t.status)}, and now no evidence in 90+ days` }
          : { kind: "RISK_CLEARED", title: t.title, detail: `No longer ${label(before.status)}; now ${label(t.status)}` },
      );
    } else if (t.section === "disposition" && before.section !== "disposition") {
      changes.push({ kind: "NOW_STALE", title: t.title, detail: "No supporting evidence in 90+ days" });
    } else if (t.status !== before.status) {
      changes.push({ kind: "STATUS_CHANGED", title: t.title, detail: `${label(before.status)} → ${label(t.status)}` });
    } else if (t.score - before.score >= SCORE_SHIFT) {
      changes.push({ kind: "PRIORITY_INCREASED", title: t.title, detail: `Attention ${before.score} → ${t.score}` });
    } else if (before.score - t.score >= SCORE_SHIFT) {
      changes.push({ kind: "PRIORITY_DECREASED", title: t.title, detail: `Attention ${before.score} → ${t.score}` });
    }
  }
  for (const t of previous.tasks) {
    if (currTasks.has(t.id)) continue;
    changes.push(
      t.section === "risk"
        ? { kind: "RISK_CLEARED", title: t.title, detail: "Finished or closed" }
        : { kind: "WORK_CLOSED", title: t.title, detail: "Finished or closed" },
    );
  }

  const prevConflicts = new Set((previous.contradictions ?? []).map((c) => c.id));
  const currConflicts = new Set((current.contradictions ?? []).map((c) => c.id));
  for (const c of current.contradictions ?? []) {
    if (!prevConflicts.has(c.id)) {
      changes.push({ kind: "NEW_CONTRADICTION", title: c.title, detail: "Newer information contradicts what's recorded" });
    }
  }
  for (const c of previous.contradictions ?? []) {
    if (!currConflicts.has(c.id)) changes.push({ kind: "CONFLICT_RESOLVED", title: c.title, detail: "Conflict resolved" });
  }

  // An old snapshot without questions says nothing about them, rather than
  // reporting every question as new.
  if (previous.questions) {
    const prevQuestions = new Map(previous.questions.map((q) => [q.id, q]));
    const currQuestions = new Map((current.questions ?? []).map((q) => [q.id, q]));
    for (const q of current.questions ?? []) {
      const before = prevQuestions.get(q.id);
      if (!before) {
        if (q.state !== "resolved") changes.push({ kind: "NEW_QUESTION", title: q.title, detail: `New strategic question (${q.state})` });
      } else if (q.state === "resolved" && before.state !== "resolved") {
        changes.push({ kind: "QUESTION_RESOLVED", title: q.title, detail: "Resolved; some decisions under it are still open" });
      } else if (q.state === "needs attention" && before.state !== "needs attention") {
        changes.push({ kind: "QUESTION_NEEDS_ATTENTION", title: q.title, detail: `Now needs attention (was ${before.state})` });
      } else if (q.state !== before.state) {
        changes.push({ kind: "QUESTION_STATE_CHANGED", title: q.title, detail: `${before.state} → ${q.state}` });
      }
    }
    for (const q of previous.questions) {
      if (!currQuestions.has(q.id) && q.state !== "resolved") {
        changes.push({ kind: "QUESTION_RESOLVED", title: q.title, detail: "Resolved" });
      }
    }
  }

  return changes.sort((a, b) => WEIGHT[b.kind] - WEIGHT[a.kind] || a.title.localeCompare(b.title));
}

export async function latestSnapshot(db: Database, organizationId: string, userId: string) {
  const [row] = await db
    .select()
    .from(executiveReviewSnapshots)
    .where(and(eq(executiveReviewSnapshots.organizationId, organizationId), eq(executiveReviewSnapshots.userId, userId)))
    .orderBy(desc(executiveReviewSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

export async function sinceLastReview(
  db: Database,
  organizationId: string,
  userId: string,
  current: ExecutiveReviewData,
): Promise<SinceLastReview | null> {
  const snapshot = await latestSnapshot(db, organizationId, userId);
  if (!snapshot) return null;
  return {
    lastReviewedAt: snapshot.createdAt.toISOString(),
    changes: diffReviews(snapshot.summary as ReviewSnapshotSummary, summarizeReview(current)),
  };
}

export async function markReviewed(db: Database, organizationId: string, userId: string, current: ExecutiveReviewData) {
  const [row] = await db
    .insert(executiveReviewSnapshots)
    .values({ organizationId, userId, summary: summarizeReview(current) })
    .returning({ createdAt: executiveReviewSnapshots.createdAt });
  return row.createdAt;
}
