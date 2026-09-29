"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  addDecisionInfo,
  assignDecision,
  createDecision,
  fetchCurrentUser,
  fetchOpenDecisions,
  resolveDecision,
  setDecisionStatus,
  setDecisionVisibility,
  type Decision,
  type SessionUser,
  type Visibility,
} from "../../lib/api";
import { Nav } from "../components/Nav";
import { SourceToggle } from "../components/SourceToggle";
import { VisibilityControl } from "../components/VisibilityControl";

const EMPTY_FORM = {
  title: "",
  decider: "",
  stakeholders: "",
  dueDate: "",
  whyItMatters: "",
  relevantContext: "",
  suggestedNextStep: "",
};

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  return new Date(dueDate).getTime() < Date.now();
}

function formatDueDate(dueDate: string): string {
  return new Date(dueDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

const STATUS_CHIP: Partial<Record<Decision["status"], string>> = {
  pending_info: "Waiting on info",
  action_in_progress: "In progress",
};

function isUndecided(d: Decision): boolean {
  return d.status === "open" || d.status === "pending_info";
}

function formatUpdated(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function DecisionsPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolutionDraft, setResolutionDraft] = useState("");
  const [alsoUnblockTask, setAlsoUnblockTask] = useState(false);
  const [keepTracking, setKeepTracking] = useState(false);
  const [savingResolution, setSavingResolution] = useState(false);

  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeDraft, setCloseDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addingInfoId, setAddingInfoId] = useState<string | null>(null);
  const [infoDraft, setInfoDraft] = useState("");
  const [savingInfo, setSavingInfo] = useState(false);

  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assignDraft, setAssignDraft] = useState("");
  const [savingAssign, setSavingAssign] = useState(false);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchOpenDecisions()
        .then(setDecisions)
        .catch((err) => setLoadError(err.message));
    }
  }, [user]);

  // Links from elsewhere (#decision-<id>) land on that decision, highlighted.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  useEffect(() => {
    const match = window.location.hash.match(/^#decision-([0-9a-f-]{36})$/i);
    if (match) setFocusId(match[1]);
  }, []);
  useEffect(() => {
    if (!focusId || decisions.length === 0) return;
    const el = document.getElementById(`decision-${focusId}`);
    if (el) {
      el.scrollIntoView({ block: "start" });
      setFocusMissing(false);
    } else {
      setFocusMissing(true);
    }
  }, [focusId, decisions]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.decider.trim()) {
      setActionError("Title and decider are required.");
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      const created = await createDecision({
        title: form.title,
        decider: form.decider,
        stakeholders: form.stakeholders
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        dueDate: form.dueDate || null,
        whyItMatters: form.whyItMatters || null,
        relevantContext: form.relevantContext || null,
        suggestedNextStep: form.suggestedNextStep || null,
      });
      setDecisions((prev) => [...prev, created]);
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setCreating(false);
    }
  }

  function startResolve(id: string) {
    setActionError(null);
    setResolutionDraft("");
    setAlsoUnblockTask(false);
    setKeepTracking(false);
    setResolvingId(id);
  }

  async function changeStatus(id: string, status: "open" | "pending_info" | "action_in_progress" | "closed", note?: string) {
    setBusyId(id);
    setActionError(null);
    try {
      const updated = await setDecisionStatus(id, status, note);
      setDecisions((prev) =>
        status === "closed" ? prev.filter((d) => d.id !== id) : prev.map((d) => (d.id === id ? { ...d, status: updated.status } : d)),
      );
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function submitClose(d: Decision) {
    // Closing a decision that was never made needs to say what happened.
    if (isUndecided(d) && !closeDraft.trim()) {
      setActionError("Say briefly what happened, so there's a record of why this closed without a decision.");
      return;
    }
    if (await changeStatus(d.id, "closed", closeDraft.trim() || undefined)) {
      setClosingId(null);
      setCloseDraft("");
    }
  }

  function startAddInfo(id: string) {
    setActionError(null);
    setInfoDraft("");
    setAddingInfoId(id);
  }

  async function submitAddInfo(id: string) {
    if (!infoDraft.trim()) {
      setActionError("Note text is required.");
      return;
    }
    setSavingInfo(true);
    setActionError(null);
    try {
      const updated = await addDecisionInfo(id, infoDraft);
      setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, relevantContext: updated.relevantContext } : d)));
      setAddingInfoId(null);
      setInfoDraft("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSavingInfo(false);
    }
  }

  function startAssign(id: string, currentDecider: string) {
    setActionError(null);
    setAssignDraft(currentDecider);
    setAssigningId(id);
  }

  async function submitAssign(id: string) {
    if (!assignDraft.trim()) {
      setActionError("Decider is required.");
      return;
    }
    setSavingAssign(true);
    setActionError(null);
    try {
      const updated = await assignDecision(id, assignDraft);
      setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, decider: updated.decider } : d)));
      setAssigningId(null);
      setAssignDraft("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSavingAssign(false);
    }
  }

  async function handleVisibilityChange(id: string, next: Visibility) {
    await setDecisionVisibility(id, next);
    setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, visibility: next } : d)));
  }

  async function submitResolve(id: string) {
    if (!resolutionDraft.trim()) {
      setActionError("Resolution text is required.");
      return;
    }
    setSavingResolution(true);
    setActionError(null);
    try {
      await resolveDecision(id, resolutionDraft, alsoUnblockTask);
      if (keepTracking) {
        // Decided, and still being carried out -- stays on this list.
        const updated = await setDecisionStatus(id, "action_in_progress");
        setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, status: updated.status } : d)));
      } else {
        setDecisions((prev) => prev.filter((d) => d.id !== id));
      }
      setResolvingId(null);
      setResolutionDraft("");
      setAlsoUnblockTask(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSavingResolution(false);
    }
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
        <p>Sign in with your Exvade Google account to see decisions.</p>
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
        <h1>Decisions</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
      {focusMissing && (
        <p className="card activity-summary">That decision isn't open anymore (it was decided, closed or merged), so it isn't in this list.</p>
      )}
      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="card-actions" style={{ marginBottom: 16 }}>
        <button className="decision-btn" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add decision"}
        </button>
      </div>

      {showForm && (
        <form className="card edit-form" onSubmit={handleCreate}>
          <label className="edit-field">
            <span className="edit-field-label">Title</span>
            <input
              className="edit-input"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Approve vendor switch for sensor boards"
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Decider</span>
            <input
              className="edit-input"
              value={form.decider}
              onChange={(e) => setForm((f) => ({ ...f, decider: e.target.value }))}
              placeholder="e.g. Sean Meehan, CEO"
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Stakeholders (comma-separated)</span>
            <input
              className="edit-input"
              value={form.stakeholders}
              onChange={(e) => setForm((f) => ({ ...f, stakeholders: e.target.value }))}
              placeholder="e.g. Ops lead, Board of Directors"
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Due date</span>
            <input
              className="edit-input"
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Why it matters</span>
            <input
              className="edit-input"
              value={form.whyItMatters}
              onChange={(e) => setForm((f) => ({ ...f, whyItMatters: e.target.value }))}
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Relevant context</span>
            <input
              className="edit-input"
              value={form.relevantContext}
              onChange={(e) => setForm((f) => ({ ...f, relevantContext: e.target.value }))}
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Suggested next step</span>
            <input
              className="edit-input"
              value={form.suggestedNextStep}
              onChange={(e) => setForm((f) => ({ ...f, suggestedNextStep: e.target.value }))}
            />
          </label>
          <div className="card-actions">
            <button className="decision-btn save" type="submit" disabled={creating}>
              Create
            </button>
          </div>
        </form>
      )}

      {decisions.length === 0 && !loadError && <p className="empty-state">No open or in-progress decisions.</p>}

      {decisions.map((d) => {
        const overdue = isOverdue(d.dueDate);
        const isResolving = resolvingId === d.id;
        const isAddingInfo = addingInfoId === d.id;
        const isAssigning = assigningId === d.id;
        return (
          <article className={`card${focusId === d.id ? " decision-focus" : ""}`} key={d.id} id={`decision-${d.id}`}>
            <div className="card-top">
              <div>
                <p className="card-title">{d.title}</p>
                <span className="muted">Decider: {d.decider}</span>
                <span className="updated-line" title={new Date(d.updatedAt).toLocaleString()}>
                  {" "}
                  &middot; Updated {formatUpdated(d.updatedAt)}
                </span>
              </div>
              <div className="card-badges">
                <VisibilityControl
                  visibility={d.visibility}
                  isAdmin={user.role === "admin"}
                  onChange={(next) => handleVisibilityChange(d.id, next)}
                />
                {STATUS_CHIP[d.status] && <span className="chip">{STATUS_CHIP[d.status]}</span>}
                {d.dueDate && isUndecided(d) && overdue ? (
                  <span className="chip chip-attention" title={`Was due ${formatDueDate(d.dueDate)}`}>
                    Deadline passed
                  </span>
                ) : (
                  d.dueDate && <span className="muted">Due {formatDueDate(d.dueDate)}</span>
                )}
              </div>
            </div>

            {d.stakeholders.length > 0 && (
              <div className="chip-row">
                {d.stakeholders.map((s) => (
                  <span className="stakeholder-chip" key={s}>
                    {s}
                  </span>
                ))}
              </div>
            )}

            <div className="decision-sections">
              {d.whyItMatters && (
                <div>
                  <p className="decision-section-label">Why it matters</p>
                  <p className="decision-section-body">{d.whyItMatters}</p>
                </div>
              )}
              {d.relevantContext && (
                <div>
                  <p className="decision-section-label">Relevant context</p>
                  <p className="decision-section-body" style={{ whiteSpace: "pre-wrap" }}>
                    {d.relevantContext}
                  </p>
                </div>
              )}
              {d.suggestedNextStep && (
                <div>
                  <p className="decision-section-label">Suggested next step</p>
                  <p className="decision-section-body">{d.suggestedNextStep}</p>
                </div>
              )}
            </div>

            {d.relatedTaskTitle && <p className="decision-meta">Related task: {d.relatedTaskTitle}</p>}

            {d.sourceId && <SourceToggle sourceId={d.sourceId} />}

            {isResolving ? (
              <div className="edit-form">
                <label className="edit-field">
                  <span className="edit-field-label">Resolution</span>
                  <input
                    className="edit-input"
                    value={resolutionDraft}
                    onChange={(e) => setResolutionDraft(e.target.value)}
                    placeholder="What was decided?"
                  />
                </label>
                <label className="edit-field edit-field-checkbox">
                  <input type="checkbox" checked={keepTracking} onChange={(e) => setKeepTracking(e.target.checked)} />
                  <span>Keep tracking it here while it&rsquo;s carried out (marks it In progress)</span>
                </label>
                {d.relatedTaskId && d.relatedTaskStatus === "blocked" && (
                  <label className="edit-field edit-field-checkbox">
                    <input
                      type="checkbox"
                      checked={alsoUnblockTask}
                      onChange={(e) => setAlsoUnblockTask(e.target.checked)}
                    />
                    <span>
                      This decision was blocking &ldquo;{d.relatedTaskTitle}&rdquo;, currently marked blocked &mdash;
                      also mark it active?
                    </span>
                  </label>
                )}
                <div className="card-actions">
                  <button
                    className="decision-btn save"
                    disabled={savingResolution}
                    onClick={() => submitResolve(d.id)}
                  >
                    Save
                  </button>
                  <button
                    className="decision-btn cancel"
                    disabled={savingResolution}
                    onClick={() => setResolvingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : isAddingInfo ? (
              <div className="edit-form">
                <label className="edit-field">
                  <span className="edit-field-label">New information</span>
                  <input
                    className="edit-input"
                    value={infoDraft}
                    onChange={(e) => setInfoDraft(e.target.value)}
                    placeholder="What's new since this was created?"
                  />
                </label>
                <div className="card-actions">
                  <button className="decision-btn save" disabled={savingInfo} onClick={() => submitAddInfo(d.id)}>
                    Save
                  </button>
                  <button className="decision-btn cancel" disabled={savingInfo} onClick={() => setAddingInfoId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : closingId === d.id ? (
              <div className="edit-form">
                <label className="edit-field">
                  <span className="edit-field-label">{isUndecided(d) ? "What happened?" : "Closing note (optional)"}</span>
                  <input
                    className="edit-input"
                    value={closeDraft}
                    onChange={(e) => setCloseDraft(e.target.value)}
                    placeholder={isUndecided(d) ? "e.g. Became moot when the vendor withdrew" : "e.g. Rollout finished"}
                  />
                </label>
                <div className="card-actions">
                  <button className="decision-btn save" disabled={busyId === d.id} onClick={() => submitClose(d)}>
                    Close decision
                  </button>
                  <button className="decision-btn cancel" disabled={busyId === d.id} onClick={() => setClosingId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : isAssigning ? (
              <div className="edit-form">
                <label className="edit-field">
                  <span className="edit-field-label">Decider</span>
                  <input
                    className="edit-input"
                    value={assignDraft}
                    onChange={(e) => setAssignDraft(e.target.value)}
                    placeholder="Who is on the hook to decide?"
                  />
                </label>
                <div className="card-actions">
                  <button className="decision-btn save" disabled={savingAssign} onClick={() => submitAssign(d.id)}>
                    Save
                  </button>
                  <button className="decision-btn cancel" disabled={savingAssign} onClick={() => setAssigningId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="card-actions">
                <button className="decision-btn" onClick={() => startAddInfo(d.id)}>
                  Add information
                </button>
                {isUndecided(d) && (
                  <>
                    <button className="decision-btn" onClick={() => startAssign(d.id, d.decider)}>
                      Assign
                    </button>
                    <button
                      className="decision-btn"
                      disabled={busyId === d.id}
                      onClick={() => changeStatus(d.id, d.status === "pending_info" ? "open" : "pending_info")}
                    >
                      {d.status === "pending_info" ? "Back to open" : "Waiting on info"}
                    </button>
                    <button className="decision-btn approve" onClick={() => startResolve(d.id)}>
                      Mark decided
                    </button>
                  </>
                )}
                <button
                  className="decision-btn"
                  onClick={() => {
                    setActionError(null);
                    setCloseDraft("");
                    setClosingId(d.id);
                  }}
                >
                  Close&hellip;
                </button>
              </div>
            )}
          </article>
        );
      })}
    </main>
  );
}
