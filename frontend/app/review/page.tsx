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
import { formatDiff, formatDiffWithCurrentState, HIDDEN_DIFF_KEYS } from "../../lib/formatDiff";
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

// Three-tier version of the same cut, for the confidence badge's color --
// gives a reviewer skimming the queue a visual "how much attention does this
// need" signal instead of making them read the number itself every time.
function confidenceTier(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.85) return "high";
  if (confidence >= CONFIDENCE_THRESHOLD) return "medium";
  return "low";
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const tier = confidenceTier(confidence);
  return (
    <div className={`confidence-badge confidence-${tier}`} title="How sure the model is about this suggestion">
      <span className="confidence-value">{Math.round(confidence * 100)}%</span>
      <span className="confidence-caption">confidence</span>
    </div>
  );
}

// Renders the objective/initiative/project chain a suggestion's target lives
// under (or would be placed under, for a brand-new entity), so a reviewer
// can tell which part of the company map an approval will affect without
// opening the target itself. Absent for objective/decision targets, or any
// suggestion whose parent chain couldn't be resolved (see loadBreadcrumbs on
// the backend).
function WorkflowBreadcrumb({ breadcrumb }: { breadcrumb: Suggestion["breadcrumb"] }) {
  if (!breadcrumb) return null;
  const parts = [breadcrumb.objective, breadcrumb.initiative, breadcrumb.project].filter(
    (p): p is { id: string; title: string } => Boolean(p),
  );
  if (parts.length === 0) return null;
  return (
    <p className="card-breadcrumb">
      {parts.map((p, i) => (
        <span key={p.id}>
          {i > 0 && <span className="breadcrumb-sep">›</span>}
          {p.title}
        </span>
      ))}
    </p>
  );
}

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

// For an update to something that already exists, the proposedDiff usually
// never mentions title at all (an operational_update touches status/
// latestUpdate, not the name) -- so the headline must come from
// currentState.title (the real existing name), not proposedDiff, or every
// update card reads as a generic "Task update" with no way to tell which
// task. A brand-new entity has no currentState, so its proposed title is the
// only name there is to show. Shared by renderCard and the project-grouping
// below, since an objective-type suggestion groups under its own name.
function cardTitle(s: Suggestion): string {
  return s.targetId
    ? String(s.currentState?.title ?? `${TARGET_LABEL[s.targetType]} update`)
    : String(s.proposedDiff.title ?? `${TARGET_LABEL[s.targetType]} update`);
}

const UNGROUPED_HEADING = "Unsorted / Other";

// Buckets suggestions under the deepest heading their breadcrumb resolves to
// (project, else initiative, else objective) so a reviewer can work through
// one part of the company map at a time instead of skimming the whole
// queue. An objective-type suggestion has no breadcrumb (nothing sits above
// an objective) but does represent a heading itself, so it groups under its
// own name. Decisions and anything else with no resolvable heading fall
// into a single catch-all bucket, sorted last since it's not a real part of
// the hierarchy.
function groupByWorkflow(items: Suggestion[]): Array<[string, Suggestion[]]> {
  const groups = new Map<string, Suggestion[]>();
  for (const s of items) {
    const heading =
      s.breadcrumb?.project?.title ??
      s.breadcrumb?.initiative?.title ??
      s.breadcrumb?.objective?.title ??
      (s.targetType === "objective" ? cardTitle(s) : UNGROUPED_HEADING);
    const bucket = groups.get(heading) ?? [];
    bucket.push(s);
    groups.set(heading, bucket);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNGROUPED_HEADING) return 1;
    if (b === UNGROUPED_HEADING) return -1;
    return a.localeCompare(b);
  });
}

type GroupMode = "confidence" | "project";

export default function ReviewPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [tab, setTab] = useState<ReviewTab>("pending");
  const [groupMode, setGroupMode] = useState<GroupMode>("confidence");
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
            <p className="card-title">{cardTitle(s)}</p>
            <span className="muted">
              {s.targetId ? `Updates existing ${TARGET_LABEL[s.targetType]}` : `Proposes new ${TARGET_LABEL[s.targetType]}`}
            </span>
            <WorkflowBreadcrumb breadcrumb={s.breadcrumb} />
          </div>
          <div className="card-top-right">
            <ConfidenceBadge confidence={s.confidence} />
            <div className="card-badges">
              {s.status === "edited" && <span className="badge badge-edited">edited</span>}
              {isHistory && <span className="badge">{s.status}</span>}
              <span className="badge">{s.changeType.replace("_", " ")}</span>
            </div>
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
          <p className="card-diff">
            {isHistory ? formatDiff(s.proposedDiff) : formatDiffWithCurrentState(s.proposedDiff, s.currentState)}
          </p>
        )}

        <p className="card-reasoning">{s.reasoning}</p>

        <p className="card-source">
          Source: {s.source.type} &middot; received {new Date(s.source.receivedAt).toLocaleString()}
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
        <span className="group-toggle">
          <button
            className={`tab-btn small${groupMode === "confidence" ? " active" : ""}`}
            onClick={() => setGroupMode("confidence")}
          >
            By attention
          </button>
          <button
            className={`tab-btn small${groupMode === "project" ? " active" : ""}`}
            onClick={() => setGroupMode("project")}
          >
            By project
          </button>
        </span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {suggestions.length === 0 && !loadError && <p className="empty-state">{TAB_EMPTY_MESSAGE[tab]}</p>}

      {groupMode === "project" ? (
        groupByWorkflow(suggestions).map(([heading, items]) => (
          <div key={heading}>
            <p className="section-title">
              {heading} ({items.length})
            </p>
            {items.map(renderCard)}
          </div>
        ))
      ) : tab === "pending" ? (
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
