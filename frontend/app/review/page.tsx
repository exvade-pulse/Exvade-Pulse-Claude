"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  decideSuggestion,
  editSuggestion,
  fetchCurrentUser,
  fetchPendingSuggestions,
  fetchSuggestionsByStatus,
  submitManualUpdate,
  type SessionUser,
  type Suggestion,
} from "../../lib/api";
import { formatDiff, HIDDEN_DIFF_KEYS } from "../../lib/formatDiff";
import { Nav } from "../components/Nav";
import { SourceToggle } from "../components/SourceToggle";

const TARGET_LABEL: Record<Suggestion["targetType"], string> = {
  objective: "Objective",
  initiative: "Initiative",
  project: "Project",
  task: "Task",
  decision: "Decision",
};

// interpret.ts's system prompt frames confidence as "how sure the model is that
// this specific target and diff are correct," 0 (low) to 1 (high), without
// drawing its own line for "safe to rubber-stamp." 0.7 is a reasonable cut for
// that: high enough that a reviewer skimming the "ready to approve" section
// isn't just trusting a coin flip, low enough that genuinely strong matches
// (the common case) don't all get dumped into "needs a closer look."
const CONFIDENCE_THRESHOLD = 0.7;

type ReviewTab = "pending" | "approved" | "rejected";

const TAB_LABEL: Record<ReviewTab, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

const TAB_EMPTY_MESSAGE: Record<ReviewTab, string> = {
  pending: "Nothing pending review. Run npm run seed:fake -w backend to generate a demo suggestion.",
  approved: "No approved suggestions yet.",
  rejected: "No rejected suggestions yet.",
};

function reviewerLabel(s: Suggestion): string {
  return s.reviewerName ?? s.reviewerEmail ?? "Unknown reviewer";
}

export default function ReviewPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [tab, setTab] = useState<ReviewTab>("pending");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Record<string, string>>({});
  const [savingEdit, setSavingEdit] = useState(false);

  const [showAddUpdate, setShowAddUpdate] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [submittingNote, setSubmittingNote] = useState(false);
  const [noteResult, setNoteResult] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      setLoadError(null);
      setActionError(null);
      setEditingId(null);
      setEditDraft({});
      setNoteResult(null);
      const load = tab === "pending" ? fetchPendingSuggestions() : fetchSuggestionsByStatus(tab);
      load.then(setSuggestions).catch((err) => setLoadError(err.message));
    }
  }, [user, tab]);

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

  function startEdit(s: Suggestion) {
    const draft: Record<string, string> = {};
    for (const [key, value] of Object.entries(s.proposedDiff)) {
      if (HIDDEN_DIFF_KEYS.has(key)) continue;
      draft[key] = String(value ?? "");
    }
    setActionError(null);
    setEditDraft(draft);
    setEditingId(s.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft({});
  }

  async function saveEdit(id: string) {
    setSavingEdit(true);
    setActionError(null);
    try {
      const updated = await editSuggestion(id, editDraft);
      setSuggestions((prev) => prev.map((s) => (s.id === id ? updated : s)));
      setEditingId(null);
      setEditDraft({});
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleSubmitNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteDraft.trim()) {
      setNoteError("Note text is required.");
      return;
    }
    setSubmittingNote(true);
    setNoteError(null);
    setNoteResult(null);
    try {
      const result = await submitManualUpdate(noteDraft);
      setNoteDraft("");
      setShowAddUpdate(false);
      setNoteResult(
        result.skippedAsNoise
          ? "Submitted, but nothing operational was found in it -- no suggestion was created."
          : `Submitted. ${result.suggestionIds.length} suggestion${result.suggestionIds.length === 1 ? "" : "s"} now pending review below.`,
      );
      if (tab === "pending" && !result.skippedAsNoise) {
        fetchPendingSuggestions().then(setSuggestions).catch((err) => setLoadError(err.message));
      }
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmittingNote(false);
    }
  }

  function renderCard(s: Suggestion) {
    const isEditing = editingId === s.id;
    const isHistory = tab !== "pending";
    return (
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
          <div className="card-badges">
            {s.status === "edited" && <span className="badge badge-edited">edited</span>}
            {isHistory && <span className="badge">{s.status}</span>}
            <span className="badge">{s.changeType.replace("_", " ")}</span>
          </div>
        </div>

        {isEditing ? (
          <div className="edit-form">
            {Object.keys(editDraft).map((key) => (
              <label className="edit-field" key={key}>
                <span className="edit-field-label">{key}</span>
                <input
                  className="edit-input"
                  value={editDraft[key]}
                  onChange={(e) => setEditDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="card-diff">{formatDiff(s.proposedDiff)}</p>
        )}

        <p className="card-reasoning">{s.reasoning}</p>

        <p className="card-source">
          Source: {s.source.type} &middot; received {new Date(s.source.receivedAt).toLocaleString()} &middot;
          confidence {Math.round(s.confidence * 100)}%
        </p>

        <SourceToggle sourceId={s.source.id} />

        {isHistory && s.reviewedAt && (
          <p className="card-source">
            {s.status === "approved" ? "Approved" : "Rejected"} by {reviewerLabel(s)} &middot;{" "}
            {new Date(s.reviewedAt).toLocaleString()}
          </p>
        )}

        {!isHistory && (
          <div className="card-actions">
            {isEditing ? (
              <>
                <button className="decision-btn save" disabled={savingEdit} onClick={() => saveEdit(s.id)}>
                  Save
                </button>
                <button className="decision-btn cancel" disabled={savingEdit} onClick={cancelEdit}>
                  Cancel
                </button>
              </>
            ) : (
              <>
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
                <button
                  className="decision-btn edit"
                  disabled={pendingActionId === s.id}
                  onClick={() => startEdit(s)}
                >
                  Edit
                </button>
              </>
            )}
          </div>
        )}
      </article>
    );
  }

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
        <p>Sign in with your Exvade Google account to review pending suggestions.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  const readyToApprove =
    tab === "pending" ? suggestions.filter((s) => s.confidence >= CONFIDENCE_THRESHOLD) : [];
  const needsCloserLook =
    tab === "pending" ? suggestions.filter((s) => s.confidence < CONFIDENCE_THRESHOLD) : [];

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>Suggestions</h1>
        <span className="muted">{user.email}</span>
      </div>

      <div className="card-actions" style={{ marginBottom: 16 }}>
        <button
          className="decision-btn"
          onClick={() => {
            setShowAddUpdate((v) => !v);
            setNoteError(null);
          }}
        >
          {showAddUpdate ? "Cancel" : "Add update"}
        </button>
      </div>

      {showAddUpdate && (
        <form className="card edit-form" onSubmit={handleSubmitNote}>
          <label className="edit-field">
            <span className="edit-field-label">
              Note (goes through the same redaction, noise-filter, and interpretation pass as email/Circleback)
            </span>
            <textarea
              className="edit-input"
              rows={5}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="e.g. Vendor confirmed the replacement sensor harness ships Friday. Need someone to update the ops team once it arrives."
            />
          </label>
          {noteError && <div className="error-banner">{noteError}</div>}
          <div className="card-actions">
            <button className="decision-btn save" type="submit" disabled={submittingNote}>
              {submittingNote ? "Submitting…" : "Submit"}
            </button>
          </div>
        </form>
      )}

      {noteResult && <p className="card activity-summary">{noteResult}</p>}

      <div className="tab-row">
        {(Object.keys(TAB_LABEL) as ReviewTab[]).map((t) => (
          <button
            key={t}
            className={`tab-btn${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {suggestions.length === 0 && !loadError && <p className="empty-state">{TAB_EMPTY_MESSAGE[tab]}</p>}

      {tab === "pending" ? (
        <>
          {readyToApprove.length > 0 && (
            <>
              <p className="section-title">Ready to approve ({readyToApprove.length})</p>
              {readyToApprove.map(renderCard)}
            </>
          )}
          {needsCloserLook.length > 0 && (
            <>
              <p className="section-title">Needs a closer look ({needsCloserLook.length})</p>
              {needsCloserLook.map(renderCard)}
            </>
          )}
        </>
      ) : (
        suggestions.map(renderCard)
      )}
    </main>
  );
}
