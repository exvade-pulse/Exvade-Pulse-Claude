"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchDashboardObjectives,
  fetchNeedsAttention,
  fetchOpenDecisions,
  fetchRecentProgress,
  fetchStatusSummary,
  type DashboardObjective,
  type DashboardTask,
  type Decision,
  type SessionUser,
  type TaskCounts,
} from "../lib/api";
import { relativeTime } from "../lib/time";
import { Nav } from "./components/Nav";
import { ChatGptReviewPanel } from "./components/ChatGptReviewPanel";
import { chipClass, STATUS_LABEL, TaskStatusChips } from "./components/TaskStatusChips";

const SNIPPET_LENGTH = 100;

function snippet(text: string | null): string | null {
  if (!text) return null;
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text;
}

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  return new Date(dueDate).getTime() < Date.now();
}

function formatDueDate(dueDate: string): string {
  return new Date(dueDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function totalTasks(counts: DashboardObjective["taskCounts"]): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function parentChain(task: DashboardTask): string {
  return [task.objective.title, task.initiative.title, task.project.title].join(" › ");
}

// Blocked/needs_attention first (most urgent), then everything else in
// workflow order -- superseded deliberately left out of the top summary
// strip: it's the least common status and represents work that was replaced
// rather than something needing anyone's attention today.
function statSummary(counts: TaskCounts) {
  return [
    { key: "blocked", label: "Blocked", value: counts.blocked, tone: "attention" as const },
    { key: "needs_attention", label: "Needs attention", value: counts.needs_attention, tone: "attention" as const },
    { key: "waiting", label: "Waiting", value: counts.waiting, tone: "neutral" as const },
    { key: "active", label: "Active", value: counts.active, tone: "neutral" as const },
    // completed + resolved combined: this schema has no single "done" status,
    // but both represent finished work in spirit -- see backend/src/db/schema.ts.
    { key: "completed", label: "Completed", value: counts.completed + counts.resolved, tone: "done" as const },
  ];
}

export default function DashboardPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [objectives, setObjectives] = useState<DashboardObjective[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [statusCounts, setStatusCounts] = useState<TaskCounts | null>(null);
  const [needsAttention, setNeedsAttention] = useState<DashboardTask[] | null>(null);
  const [recentProgress, setRecentProgress] = useState<DashboardTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      Promise.all([
        fetchDashboardObjectives(),
        fetchOpenDecisions(),
        fetchStatusSummary(),
        fetchNeedsAttention(),
        fetchRecentProgress(),
      ])
        .then(([objectivesRes, decisionsRes, statusRes, needsAttentionRes, recentProgressRes]) => {
          setObjectives(objectivesRes);
          setDecisions(decisionsRes);
          setStatusCounts(statusRes);
          setNeedsAttention(needsAttentionRes);
          setRecentProgress(recentProgressRes);
        })
        .catch((err) => setLoadError(err.message));
    }
  }, [user]);

  if (user === "loading") {
    return (
      <main className="page">
        <Nav />
        <p className="muted">Loading&hellip;</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="page">
        <Nav />
        <div className="header">
          <h1>Exvade Pulse</h1>
        </div>
        <p>Sign in with your Exvade Google account to see the strategy map.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  // Soonest due date first, nulls last -- the same order /api/decisions
  // already returns them in, so this just takes the front of that list
  // rather than re-sorting.
  const topDecisions = decisions.slice(0, 3);

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>Dashboard</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <ChatGptReviewPanel isAdmin={user.role === "admin"} />

      <h2 className="section-title">Decisions needed</h2>
      {topDecisions.length === 0 ? (
        <p className="empty-state">Nothing needs a decision right now.</p>
      ) : (
        <div className="card task-list">
          {topDecisions.map((d) => {
            const overdue = isOverdue(d.dueDate);
            return (
              <div className="task-row" key={d.id}>
                <div className="task-row-top">
                  <Link className="task-row-title" href="/decisions">
                    {d.title}
                  </Link>
                  {d.dueDate && (
                    <span className={overdue ? "due-overdue" : "muted"}>
                      Due {formatDueDate(d.dueDate)}
                      {overdue ? " (overdue)" : ""}
                    </span>
                  )}
                </div>
                <p className="task-row-meta">Decider: {d.decider}</p>
              </div>
            );
          })}
        </div>
      )}
      {decisions.length > 0 && (
        <p className="card-summary">
          <Link href="/decisions">View all decisions &rarr;</Link>
        </p>
      )}

      <h2 className="section-title">Company status</h2>
      {statusCounts && (
        <div className="stat-row">
          {statSummary(statusCounts).map((stat) => (
            <div className={`stat-item stat-item-${stat.tone}`} key={stat.key}>
              <div className="stat-value">{stat.value}</div>
              <div className="stat-label">{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">Needs attention</h2>
      {needsAttention && needsAttention.length === 0 && (
        <p className="empty-state">Nothing needs attention right now.</p>
      )}
      {needsAttention && needsAttention.length > 0 && (
        <div className="card task-list">
          {needsAttention.map((t) => (
            <div className="task-row" key={t.id}>
              <div className="task-row-top">
                <Link className="task-row-title" href={`/tasks/${t.id}`}>
                  {t.title}
                </Link>
                <span className="task-row-tags">
                  {t.sourceCount > 0 && (
                    <span className="chip" title="Approved suggestions citing a source">
                      {t.sourceCount} source{t.sourceCount === 1 ? "" : "s"}
                    </span>
                  )}
                  <span className={chipClass(t.status)}>{STATUS_LABEL[t.status]}</span>
                </span>
              </div>
              <p className="task-row-meta">
                {t.owner && <>Owner: {t.owner} &middot; </>}
                {parentChain(t)}
              </p>
              {t.blockingDecision && (
                <p className="task-snippet blocking-decision">
                  Blocked &mdash; waiting on decision:{" "}
                  <Link href="/decisions">{t.blockingDecision.title}</Link>
                </p>
              )}
              {snippet(t.latestUpdate) && (
                <p className="task-snippet">
                  <span className="task-snippet-label">Latest:</span> {snippet(t.latestUpdate)}
                </p>
              )}
              {snippet(t.nextAction) && (
                <p className="task-snippet">
                  <span className="task-snippet-label">Next:</span> {snippet(t.nextAction)}
                </p>
              )}
              <span className="muted task-row-time">Updated {relativeTime(t.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">Recent progress</h2>
      {recentProgress && recentProgress.length === 0 && (
        <p className="empty-state">No recent completions yet.</p>
      )}
      {recentProgress && recentProgress.length > 0 && (
        <div className="card task-list">
          {recentProgress.map((t) => (
            <div className="task-row" key={t.id}>
              <div className="task-row-top">
                <Link className="task-row-title" href={`/tasks/${t.id}`}>
                  {t.title}
                </Link>
                <span className="task-row-tags">
                  {t.sourceCount > 0 && (
                    <span className="chip" title="Approved suggestions citing a source">
                      {t.sourceCount} source{t.sourceCount === 1 ? "" : "s"}
                    </span>
                  )}
                  <span className="chip chip-done">{STATUS_LABEL[t.status]}</span>
                </span>
              </div>
              <p className="task-row-meta">
                {t.owner && <>Owner: {t.owner} &middot; </>}
                {parentChain(t)}
              </p>
              {snippet(t.latestUpdate) && (
                <p className="task-snippet">
                  <span className="task-snippet-label">Latest:</span> {snippet(t.latestUpdate)}
                </p>
              )}
              <span className="muted task-row-time">Updated {relativeTime(t.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">Strategy map</h2>

      {objectives.length === 0 && !loadError && (
        <p className="empty-state">No objectives yet.</p>
      )}

      {objectives.map((o) => {
        const total = totalTasks(o.taskCounts);
        const nonSuperseded = total - o.taskCounts.superseded;
        const completedPct = nonSuperseded > 0 ? Math.round((o.taskCounts.completed / nonSuperseded) * 100) : null;
        const objectiveNeedsAttention = o.taskCounts.needs_attention + o.taskCounts.blocked;

        return (
          <article className="card" key={o.id}>
            <div className="card-top">
              <div>
                <Link className="card-title card-title-link" href={`/objectives/${o.id}`}>
                  {o.title}
                </Link>
                {o.description && <span className="muted">{o.description}</span>}
                {o.owner && <span className="owner-line">Owner: {o.owner}</span>}
              </div>
              <div className="card-badges">
                <span className={`badge badge-priority-${o.priority}`}>{o.priority}</span>
                <span className="badge">{o.status}</span>
              </div>
            </div>

            <p className="card-summary">
              {o.initiativeCount} initiative{o.initiativeCount === 1 ? "" : "s"} &middot; {objectiveNeedsAttention} needs
              attention
            </p>

            <TaskStatusChips counts={o.taskCounts} />

            {completedPct !== null && (
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${completedPct}%` }} />
              </div>
            )}
          </article>
        );
      })}
    </main>
  );
}
