"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchDashboardObjectives,
  type DashboardObjective,
  type SessionUser,
  type TaskStatus,
} from "../lib/api";
import { Nav } from "./components/Nav";

// Workflow order, not alphabetical -- what needs eyes on it (active work, then
// trouble) reads before what's settled (resolved/completed/superseded).
const STATUS_ORDER: TaskStatus[] = [
  "active",
  "needs_attention",
  "blocked",
  "waiting",
  "resolved",
  "completed",
  "superseded",
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  active: "active",
  waiting: "waiting",
  needs_attention: "needs attention",
  completed: "completed",
  superseded: "superseded",
  resolved: "resolved",
  blocked: "blocked",
};

function totalTasks(counts: DashboardObjective["taskCounts"]): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function chipClass(status: TaskStatus): string {
  if (status === "needs_attention" || status === "blocked") return "chip chip-attention";
  if (status === "completed") return "chip chip-done";
  return "chip";
}

export default function DashboardPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [objectives, setObjectives] = useState<DashboardObjective[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchDashboardObjectives()
        .then(setObjectives)
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

  return (
    <main className="page">
      <Nav />
      <div className="header">
        <h1>Strategy map</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {objectives.length === 0 && !loadError && (
        <p className="empty-state">No objectives yet.</p>
      )}

      {objectives.map((o) => {
        const total = totalTasks(o.taskCounts);
        const nonSuperseded = total - o.taskCounts.superseded;
        const completedPct = nonSuperseded > 0 ? Math.round((o.taskCounts.completed / nonSuperseded) * 100) : null;
        const needsAttention = o.taskCounts.needs_attention + o.taskCounts.blocked;
        const activeStatuses = STATUS_ORDER.filter((status) => o.taskCounts[status] > 0);

        return (
          <article className="card" key={o.id}>
            <div className="card-top">
              <div>
                <p className="card-title">{o.title}</p>
                {o.description && <span className="muted">{o.description}</span>}
              </div>
              <div className="card-badges">
                <span className={`badge badge-priority-${o.priority}`}>{o.priority}</span>
                <span className="badge">{o.status}</span>
              </div>
            </div>

            <p className="card-summary">
              {o.initiativeCount} initiative{o.initiativeCount === 1 ? "" : "s"} &middot; {needsAttention} needs
              attention
            </p>

            {activeStatuses.length > 0 ? (
              <div className="chip-row">
                {activeStatuses.map((status) => (
                  <span className={chipClass(status)} key={status}>
                    {o.taskCounts[status]} {STATUS_LABEL[status]}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">No tasks yet.</p>
            )}

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
