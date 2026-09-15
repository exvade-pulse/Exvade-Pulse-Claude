"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  createDecision,
  fetchCurrentUser,
  fetchOpenDecisions,
  resolveDecision,
  type Decision,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";

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
  return new Date(dueDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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
  const [savingResolution, setSavingResolution] = useState(false);

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
    setResolvingId(id);
  }

  async function submitResolve(id: string) {
    if (!resolutionDraft.trim()) {
      setActionError("Resolution text is required.");
      return;
    }
    setSavingResolution(true);
    setActionError(null);
    try {
      await resolveDecision(id, resolutionDraft);
      setDecisions((prev) => prev.filter((d) => d.id !== id));
      setResolvingId(null);
      setResolutionDraft("");
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
      <Nav />
      <div className="header">
        <h1>Decisions</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
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

      {decisions.length === 0 && !loadError && <p className="empty-state">No open decisions.</p>}

      {decisions.map((d) => {
        const overdue = isOverdue(d.dueDate);
        const isResolving = resolvingId === d.id;
        return (
          <article className="card" key={d.id}>
            <div className="card-top">
              <div>
                <p className="card-title">{d.title}</p>
                <span className="muted">Decider: {d.decider}</span>
              </div>
              {d.dueDate && (
                <span className={overdue ? "due-overdue" : "muted"}>
                  Due {formatDueDate(d.dueDate)}
                  {overdue ? " (overdue)" : ""}
                </span>
              )}
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
                  <p className="decision-section-body">{d.relevantContext}</p>
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
            ) : (
              <div className="card-actions">
                <button className="decision-btn approve" onClick={() => startResolve(d.id)}>
                  Mark decided
                </button>
              </div>
            )}
          </article>
        );
      })}
    </main>
  );
}
