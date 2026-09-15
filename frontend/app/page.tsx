"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  decideSuggestion,
  fetchCurrentUser,
  fetchPendingSuggestions,
  type SessionUser,
  type Suggestion,
} from "../lib/api";

const TARGET_LABEL: Record<Suggestion["targetType"], string> = {
  objective: "Objective",
  initiative: "Initiative",
  project: "Project",
  task: "Task",
};

// Foreign keys (objectiveId, projectId, ...) are implementation detail, not
// something a reviewer needs to read — "where it belongs" is already conveyed by
// the "Proposes new X" / "Updates existing X" line above the diff.
const HIDDEN_DIFF_KEYS = new Set(["objectiveId", "initiativeId", "projectId"]);

function formatDiff(diff: Record<string, unknown>): string {
  return Object.entries(diff)
    .filter(([key]) => !HIDDEN_DIFF_KEYS.has(key))
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

export default function ReviewPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchPendingSuggestions()
        .then(setSuggestions)
        .catch((err) => setLoadError(err.message));
    }
  }, [user]);

  async function handleDecision(id: string, decision: "approve" | "reject") {
    setPendingActionId(id);
    setActionError(null);
    try {
      await decideSuggestion(id, decision);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPendingActionId(null);
    }
  }

  if (user === "loading") {
    return (
      <main className="page">
        <p className="muted">Loading&hellip;</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="page">
        <div className="header">
          <h1>Exvade Pulse</h1>
        </div>
        <p>Sign in with your Exvade Google account to review pending suggestions.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="header">
        <h1>Pending suggestions</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {suggestions.length === 0 && !loadError && (
        <p className="empty-state">
          Nothing pending review. Run <code>npm run seed:fake -w backend</code> to generate a demo suggestion.
        </p>
      )}

      {suggestions.map((s) => (
        <article className="card" key={s.id}>
          <div className="card-top">
            <div>
              <p className="card-title">
                {String(s.proposedDiff.title ?? `${TARGET_LABEL[s.targetType]} update`)}
              </p>
              <span className="muted">
                {s.targetId ? `Updates existing ${TARGET_LABEL[s.targetType]}` : `Proposes new ${TARGET_LABEL[s.targetType]}`}
              </span>
            </div>
            <span className="badge">{s.changeType.replace("_", " ")}</span>
          </div>

          <p className="card-diff">{formatDiff(s.proposedDiff)}</p>
          <p className="card-reasoning">{s.reasoning}</p>

          <p className="card-source">
            Source: {s.source.type} &middot; received {new Date(s.source.receivedAt).toLocaleString()} &middot;
            confidence {Math.round(s.confidence * 100)}%
          </p>

          <div className="card-actions">
            <button
              className="decision-btn approve"
              disabled={pendingActionId === s.id}
              onClick={() => handleDecision(s.id, "approve")}
            >
              Approve
            </button>
            <button
              className="decision-btn reject"
              disabled={pendingActionId === s.id}
              onClick={() => handleDecision(s.id, "reject")}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </main>
  );
}
