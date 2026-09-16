"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchDashboardObjectives,
  type DashboardObjective,
  type SessionUser,
} from "../lib/api";
import { Nav } from "./components/Nav";
import { TaskStatusChips } from "./components/TaskStatusChips";

function totalTasks(counts: DashboardObjective["taskCounts"]): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
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
      <Nav user={user} />
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
              {o.initiativeCount} initiative{o.initiativeCount === 1 ? "" : "s"} &middot; {needsAttention} needs
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
