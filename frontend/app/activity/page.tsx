"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL, fetchActivity, fetchCurrentUser, type ActivityEntry, type SessionUser } from "../../lib/api";
import { relativeTime } from "../../lib/time";
import { Nav } from "../components/Nav";

// Covers every action string current write sites actually produce (see
// suggestions/apply.ts, decisions/manage.ts, users/manage.ts,
// integrations/manage.ts) -- anything not listed falls back to a generic
// humanization rather than crashing on an unrecognized action.
const ACTION_LABELS: Record<string, string> = {
  "suggestion.approved": "approved a suggestion",
  "suggestion.edited": "edited a suggestion",
  "suggestion.rejected": "rejected a suggestion",
  "decision.created": "created a decision",
  "decision.resolved": "resolved a decision",
  "user.authorized": "authorized a user",
  "user.role_changed": "changed a user's role",
  "user.revoked": "revoked a user's access",
  "integration.token_generated": "generated an integration token",
  "integration.token_rotated": "rotated an integration token",
};

function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

const LINKABLE_ENTITY_TYPES = new Set(["objective", "initiative", "project", "task"]);

function entityHref(entityType: string, entityId: string): string {
  return `/${entityType}s/${entityId}`;
}

function actorLabel(entry: ActivityEntry): string {
  return entry.actorName ?? entry.actorEmail ?? "System";
}

export default function ActivityPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [entries, setEntries] = useState<ActivityEntry[] | "loading">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchActivity()
        .then(setEntries)
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
        <p>Sign in with your Exvade Google account to see recent activity.</p>
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
        <h1>Activity</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {entries === "loading" && <p className="muted">Loading&hellip;</p>}

      {entries !== "loading" && entries.length === 0 && !loadError && (
        <p className="empty-state">No activity yet.</p>
      )}

      {entries !== "loading" && entries.length > 0 && (
        <div className="card activity-list">
          {entries.map((entry) => (
            <div className="activity-row" key={entry.id}>
              <div className="activity-row-main">
                <span className="activity-actor">{actorLabel(entry)}</span>{" "}
                <span className="activity-action">{humanizeAction(entry.action)}</span>
                {LINKABLE_ENTITY_TYPES.has(entry.entityType) && entry.entityId && (
                  <>
                    {" "}
                    <Link className="activity-entity-link" href={entityHref(entry.entityType, entry.entityId)}>
                      View {entry.entityType}
                    </Link>
                  </>
                )}
              </div>
              <span className="muted activity-time">{relativeTime(entry.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
