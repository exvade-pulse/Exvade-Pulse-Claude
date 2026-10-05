"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  API_URL,
  createQuestion,
  fetchCurrentUser,
  fetchQuestions,
  linkToQuestion,
  reopenQuestion,
  resolveQuestion,
  suggestQuestions,
  unlinkFromQuestion,
  updateQuestion,
  type QuestionLinkType,
  type QuestionsResponse,
  type SessionUser,
  type StrategicQuestion,
} from "../../lib/api";
import { Nav } from "../components/Nav";

const LINK_LABEL: Record<QuestionLinkType, string> = { decision: "Decision", task: "Task", project: "Project" };

function linkHref(type: QuestionLinkType, id: string): string {
  if (type === "task") return `/tasks/${id}`;
  if (type === "project") return `/projects/${id}`;
  return "/decisions";
}

function QuestionItem({
  question: q,
  linkable,
  onChanged,
}: {
  question: StrategicQuestion;
  linkable: QuestionsResponse["linkable"];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(q.title);
  const [hypothesis, setHypothesis] = useState(q.hypothesis ?? "");
  const [label, setLabel] = useState(q.label ?? "");
  const [nextAction, setNextAction] = useState(q.nextAction ?? "");
  const [owner, setOwner] = useState(q.owner ?? "");
  const [keyDependency, setKeyDependency] = useState(q.keyDependency ?? "");
  const [linkType, setLinkType] = useState<QuestionLinkType>("decision");
  const [linkId, setLinkId] = useState("");
  const [resolving, setResolving] = useState(false);
  const [answer, setAnswer] = useState("");
  const [stillOpen, setStillOpen] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const linked = new Set(q.links.map((l) => `${l.type}:${l.id}`));
  const options =
    linkType === "decision"
      ? linkable.decisions.map((d) => ({ id: d.id, label: d.title }))
      : linkType === "task"
        ? linkable.tasks.map((t) => ({ id: t.id, label: `${t.title} (${t.project})` }))
        : linkable.projects.map((p) => ({ id: p.id, label: p.title }));
  const available = options.filter((o) => !linked.has(`${linkType}:${o.id}`));

  return (
    <article className={`card rc-card${q.status === "resolved" ? " question-resolved" : ""}`}>
      <div className="rc-top">
        {editing ? (
          <input className="edit-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Question" />
        ) : (
          <p className="card-title rc-title">{q.title}</p>
        )}
        <span className={q.status === "resolved" ? "chip chip-done" : "chip"}>{q.status}</span>
      </div>

      {editing ? (
        <div className="edit-form">
          <label className="edit-field">
            <span className="edit-field-label">Short title (shown on the Executive page)</span>
            <input className="edit-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Clinical Sampling / White Pellet" />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Next action</span>
            <input className="edit-input" value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="The one next step" />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Owner</span>
            <input className="edit-input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Sean / Duke" />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Depends on</span>
            <input className="edit-input" value={keyDependency} onChange={(e) => setKeyDependency(e.target.value)} placeholder="e.g. Sample availability and assay plan" />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Working hypothesis</span>
            <textarea className="edit-input" rows={2} value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} />
          </label>
          <div className="card-actions">
            <button
              className="decision-btn save"
              disabled={busy || !title.trim()}
              onClick={() =>
                run(async () => {
                  await updateQuestion(q.id, {
                    title,
                    hypothesis: hypothesis.trim() || null,
                    label: label.trim() || null,
                    nextAction: nextAction.trim() || null,
                    owner: owner.trim() || null,
                    keyDependency: keyDependency.trim() || null,
                  });
                  setEditing(false);
                })
              }
            >
              Save
            </button>
            <button className="decision-btn cancel" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {q.label && <p className="rc-meta">Shown as: {q.label}</p>}
          {q.nextAction && (
            <p className="rc-line">
              <span className="rc-label">Next</span> {q.nextAction}
            </p>
          )}
          {(q.owner || q.keyDependency) && (
            <p className="rc-meta">
              {q.owner && <>Owner: {q.owner}</>}
              {q.owner && q.keyDependency && " · "}
              {q.keyDependency && <>Depends on: {q.keyDependency}</>}
            </p>
          )}
          {q.hypothesis && (
            <p className="rc-line">
              <span className="rc-label">Hypothesis</span> {q.hypothesis}
            </p>
          )}
          {q.resolution && (
            <p className="rc-line">
              <span className="rc-label">Answer</span> {q.resolution}
            </p>
          )}
        </>
      )}

      {q.links.length === 0 ? (
        <p className="rc-meta">Nothing linked yet.</p>
      ) : (
        <ul className="rc-list question-links">
          {q.links.map((l) => (
            <li key={`${l.type}:${l.id}`}>
              <span className="muted">{LINK_LABEL[l.type]}:</span> <Link href={linkHref(l.type, l.id)}>{l.title}</Link>{" "}
              <span className="muted">({l.status.replace("_", " ")})</span>{" "}
              <button className="link-btn" disabled={busy} onClick={() => run(() => unlinkFromQuestion(q.id, l.type, l.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {q.status === "open" && (
        <div className="question-link-row">
          <select
            className="edit-input"
            value={linkType}
            onChange={(e) => {
              setLinkType(e.target.value as QuestionLinkType);
              setLinkId("");
            }}
            aria-label="Record type"
          >
            <option value="decision">Decision</option>
            <option value="task">Task</option>
            <option value="project">Project</option>
          </select>
          <select className="edit-input" value={linkId} onChange={(e) => setLinkId(e.target.value)} aria-label="Record to link">
            <option value="">Link a {LINK_LABEL[linkType].toLowerCase()}…</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            className="decision-btn"
            disabled={busy || !linkId}
            onClick={() =>
              run(async () => {
                await linkToQuestion(q.id, linkType, linkId);
                setLinkId("");
              })
            }
          >
            Link
          </button>
        </div>
      )}

      {resolving && (
        <div className="edit-form">
          <label className="edit-field">
            <span className="edit-field-label">Answer</span>
            <input className="edit-input" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="What did we conclude?" />
          </label>
          <div className="card-actions">
            <button
              className="decision-btn save"
              disabled={busy || !answer.trim()}
              onClick={() =>
                run(async () => {
                  const result = await resolveQuestion(q.id, answer);
                  setStillOpen(result.openDecisions.map((d) => d.title));
                  setResolving(false);
                })
              }
            >
              Resolve
            </button>
            <button className="decision-btn cancel" onClick={() => setResolving(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {stillOpen && stillOpen.length > 0 && (
        <p className="rc-line stale-note">
          Resolved. These decisions are still open. Close or update each one on the <Link href="/decisions">Decisions page</Link>:{" "}
          {stillOpen.join(" · ")}
        </p>
      )}

      {error && <p className="error-inline">{error}</p>}

      {!editing && !resolving && (
        <div className="card-actions">
          <button className="decision-btn edit" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
          {q.status === "open" ? (
            <button className="decision-btn approve" disabled={busy} onClick={() => setResolving(true)}>
              Resolve
            </button>
          ) : (
            <button className="decision-btn" disabled={busy} onClick={() => run(() => reopenQuestion(q.id))}>
              Reopen
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export default function QuestionsPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<QuestionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ objectiveId: "", title: "", hypothesis: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestResult, setSuggestResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchQuestions());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load questions");
    }
  }, []);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") load();
  }, [user, load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await createQuestion({ objectiveId: form.objectiveId, title: form.title, hypothesis: form.hypothesis.trim() || null });
      setForm({ objectiveId: form.objectiveId, title: "", hypothesis: "" });
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  async function handleSuggest() {
    setSuggesting(true);
    setSuggestResult(null);
    try {
      const r = await suggestQuestions();
      const why = [
        r.skipped?.noAnswer && "the AI didn't return an answer this time (try again)",
        r.skipped?.alreadyExists && `${r.skipped.alreadyExists} matched a question that already exists or is waiting in Review`,
        r.skipped?.tooFewLinks && `${r.skipped.tooFewLinks} linked fewer than two decisions or tasks`,
        r.skipped?.malformed && `${r.skipped.malformed} came back incomplete`,
        r.skipped?.unknownObjective && `${r.skipped.unknownObjective} named an outcome that wasn't found`,
      ].filter(Boolean);
      const pending = r.alreadyPending ? ` ${r.alreadyPending} suggested question${r.alreadyPending === 1 ? " is" : "s are"} already waiting in Review.` : "";
      setSuggestResult(
        r.questionsProposed === 0
          ? `No new questions suggested${why.length ? `: ${why.join("; ")}` : " (the AI found no new strategic questions)"}.${pending}`
          : `${r.questionsProposed} question${r.questionsProposed === 1 ? "" : "s"} suggested${
              r.conversionsProposed ? ` (${r.conversionsProposed} from over-broad decisions)` : ""
            }. They're waiting in Review for your approval.`,
      );
    } catch (err) {
      setSuggestResult(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSuggesting(false);
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
        <p>Sign in with your Exvade Google account to see strategic questions.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  const byObjective = new Map<string, StrategicQuestion[]>();
  for (const q of data?.questions ?? []) byObjective.set(q.objective, [...(byObjective.get(q.objective) ?? []), q]);
  const groups = [...byObjective.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>Strategic questions</h1>
        <div className="card-actions">
          <button className="decision-btn" disabled={suggesting} onClick={handleSuggest}>
            {suggesting ? "Thinking…" : "Suggest questions with AI"}
          </button>
          <button className="decision-btn" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Add question"}
          </button>
        </div>
      </div>
      <p className="muted">
        The big open questions each objective depends on. Link the decisions and work that feed each one; the Executive review
        rolls them up. AI suggestions go to <Link href="/review">Review</Link> first.
      </p>
      {suggestResult && <p className="card activity-summary">{suggestResult}</p>}

      {showForm && data && (
        <form className="card edit-form" onSubmit={handleCreate}>
          <label className="edit-field">
            <span className="edit-field-label">Objective</span>
            <select className="edit-input" value={form.objectiveId} onChange={(e) => setForm((f) => ({ ...f, objectiveId: e.target.value }))}>
              <option value="">Choose an objective…</option>
              {data.linkable.objectives.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Question</span>
            <input
              className="edit-input"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Can we sample reliably enough for diagnostic use?"
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Working hypothesis (optional)</span>
            <textarea
              className="edit-input"
              rows={2}
              value={form.hypothesis}
              onChange={(e) => setForm((f) => ({ ...f, hypothesis: e.target.value }))}
              placeholder="Your current best answer"
            />
          </label>
          {formError && <p className="error-inline">{formError}</p>}
          <div className="card-actions">
            <button className="decision-btn save" type="submit" disabled={saving || !form.objectiveId || !form.title.trim()}>
              {saving ? "Saving…" : "Add question"}
            </button>
          </div>
        </form>
      )}

      {loadError && <div className="error-banner">{loadError}</div>}
      {!data && !loadError && <p className="muted">Loading&hellip;</p>}
      {data && data.questions.length === 0 && (
        <p className="empty-inline">No strategic questions yet. Try &ldquo;Suggest questions with AI&rdquo; for a first set.</p>
      )}
      {data &&
        groups.map(([objective, list]) => (
          <section key={objective}>
            <h2 className="section-title">{objective}</h2>
            {list.map((q) => (
              <QuestionItem key={q.id} question={q} linkable={data.linkable} onChanged={load} />
            ))}
          </section>
        ))}
    </main>
  );
}
