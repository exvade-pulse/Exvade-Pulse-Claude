"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchActivity,
  fetchCurrentUser,
  type ActivityEntry,
  type ActivityResponse,
  type SessionUser,
} from "../../lib/api";
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Templated from real counts, not an LLM call -- see backend/src/routes/activity.ts's
// summary computation. Handles the zero/singular/plural cases so the sentence never
// reads "1 status moves" or names a null "most urgent" decision.
function buildSummarySentence(summary: ActivityResponse["summary"]): string {
  const { statusMoves, completions, newDecisions, openDecisionsCount, mostUrgentOpenDecision } = summary;

  const nothingSinceLastVisit = statusMoves === 0 && completions === 0 && newDecisions === 0;
  const nothingNeedsAttention = openDecisionsCount === 0;
  if (nothingSinceLastVisit && nothingNeedsAttention) {
    return "Nothing new since your last visit.";
  }

  const recap = `${plural(statusMoves, "status move")}, ${plural(completions, "completion")}, and ${plural(
    newDecisions,
    "new decision",
  )} were recorded since your last visit.`;

  if (nothingNeedsAttention) {
    return recap;
  }

  const attention = `${plural(openDecisionsCount, "decision")} still need${
    openDecisionsCount === 1 ? "s" : ""
  } attention${mostUrgentOpenDecision ? ` — the most urgent is '${mostUrgentOpenDecision.title}'.` : "."}`;

  return `${recap} ${attention}`;
}

export default function ActivityPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [activity, setActivity] = useState<ActivityResponse | "loading">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchActivity()
        .then(setActivity)
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

  const entries = activity === "loading" ? "loading" : activity.entries;

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>What changed</h1>
        <span className="muted">
          {activity !== "loading" &&
            (activity.previousLastActivityViewAt
              ? `Last visit ${relativeTime(activity.previousLastActivityViewAt)}`
              : "First visit")}
        </span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {activity === "loading" && <p className="muted">Loading&hellip;</p>}

      {activity !== "loading" && (
        <p className="card activity-summary">{buildSummarySentence(activity.summary)}</p>
      )}

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
