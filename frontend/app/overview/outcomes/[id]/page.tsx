"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fetchCompanyMap, fetchCurrentUser, fetchOpenDecisions, type CompanyMapResponse, type Decision, type SessionUser } from "../../../../lib/api";
import {
  createMilestone,
  createRisk,
  fetchOutcome,
  formatDay,
  HEALTH_LABEL,
  linkMilestone,
  setHealth,
  unlinkMilestone,
  updateDecisionOverview,
  updateMilestone,
  updateOutcome,
  updateRisk,
  type Confidence,
  type Health,
  type MilestoneDetail,
  type OutcomeDetail,
  type RiskDetail,
} from "../../../../lib/overview";
import { Nav } from "../../../components/Nav";
import { HealthBadge } from "../../../components/overview/Parts";
import { decisionHref } from "../../../components/Dashboard";

// One outcome in full: its health and why, milestones and what they depend
// on, the decisions and risks attached to it, and the work under it. Every
// edit button is hidden in read-only review mode.

type Tab = "summary" | "milestones" | "decisions" | "risks" | "work";
const TABS: Array<[Tab, string]> = [
  ["summary", "Summary"],
  ["milestones", "Milestones"],
  ["decisions", "Decisions"],
  ["risks", "Risks"],
  ["work", "Work"],
];

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="edit-field">
      <span className="edit-field-label">{label}</span>
      {children}
    </label>
  );
}

// --- Summary ----------------------------------------------------------------

function HealthForm({ detail, reload }: { detail: OutcomeDetail; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [health, setHealthValue] = useState<Health>(detail.objective.health === "not_assessed" ? "on_track" : detail.objective.health);
  const [rationale, setRationale] = useState("");
  const [reviewBy, setReviewBy] = useState("");
  const { busy, error, run } = useAction(reload);
  if (!open) {
    return (
      <button className="decision-btn" onClick={() => setOpen(true)}>
        {detail.objective.health === "not_assessed" ? "Assess health" : "Update health"}
      </button>
    );
  }
  return (
    <div className="xo-form">
      <Field label="Health">
        <select className="edit-input" value={health} onChange={(e) => setHealthValue(e.target.value as Health)}>
          {(["on_track", "at_risk", "blocked", "not_assessed"] as Health[]).map((h) => (
            <option key={h} value={h}>
              {HEALTH_LABEL[h]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Why (one line, shown on the overview)">
        <input className="edit-input" value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="e.g. Verification can't start until aged domes arrive" />
      </Field>
      <Field label="Look at this again by (optional)">
        <input className="edit-input" type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} />
      </Field>
      {error && <p className="error-inline">{error}</p>}
      <div className="card-actions">
        <button
          className="decision-btn save"
          disabled={busy}
          onClick={() => run(() => setHealth(detail.objective.id, { health, rationale, reviewBy: reviewBy || null }), () => setOpen(false))}
        >
          Save assessment
        </button>
        <button className="decision-btn cancel" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function OutcomeFields({ detail, reload }: { detail: OutcomeDetail; reload: () => Promise<void> }) {
  const o = detail.objective;
  const [open, setOpen] = useState(false);
  const [rationale, setRationale] = useState(o.rationale ?? "");
  const [owner, setOwner] = useState(o.owner ?? "");
  const [order, setOrder] = useState(o.displayOrder?.toString() ?? "");
  const { busy, error, run } = useAction(reload);
  if (!open) {
    return (
      <button className="decision-btn" onClick={() => setOpen(true)}>
        Edit why it matters, owner and order
      </button>
    );
  }
  return (
    <div className="xo-form">
      <Field label="Why it matters (one sentence)">
        <input className="edit-input" value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </Field>
      <Field label="Owner">
        <input className="edit-input" value={owner} onChange={(e) => setOwner(e.target.value)} />
      </Field>
      <Field label="Position on the overview (1 = first)">
        <input className="edit-input" inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value.replace(/\D/g, ""))} />
      </Field>
      {error && <p className="error-inline">{error}</p>}
      <div className="card-actions">
        <button
          className="decision-btn save"
          disabled={busy}
          onClick={() => run(() => updateOutcome(o.id, { rationale: rationale || null, owner: owner || null, displayOrder: order ? Number(order) : null }), () => setOpen(false))}
        >
          Save
        </button>
        <button className="decision-btn cancel" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Summary({ detail, reload }: { detail: OutcomeDetail; reload: () => Promise<void> }) {
  const o = detail.objective;
  return (
    <div className="xo-stack">
      <section className="xo-card">
        <h2 className="xo-label">Health</h2>
        <p>
          <HealthBadge health={o.health} />{" "}
          {o.healthAssessedAt ? (
            <span className="xo-meta">
              assessed {formatDay(day(o.healthAssessedAt))}
              {o.healthAssessedBy ? ` by ${o.healthAssessedBy}` : ""}
            </span>
          ) : (
            <span className="xo-meta">never assessed</span>
          )}
        </p>
        {o.healthRationale && <p>{o.healthRationale}</p>}
        <HealthForm detail={detail} reload={reload} />
        {detail.history.length > 1 && (
          <details className="xo-details">
            <summary>Earlier assessments ({detail.history.length - 1})</summary>
            <ul className="xo-list">
              {detail.history.slice(1).map((h) => (
                <li key={h.id}>
                  <HealthBadge health={h.health} /> <span className="xo-meta">{formatDay(day(h.assessedAt))}{h.assessedBy ? ` · ${h.assessedBy}` : ""}</span>
                  {h.rationale && <span className="xo-attn-detail">{h.rationale}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <section className="xo-card">
        <h2 className="xo-label">Why it matters</h2>
        {o.rationale ? <p>{o.rationale}</p> : <p className="xo-empty">Not written yet.</p>}
        <p className="xo-meta">Owner: {o.owner ?? "not assigned"}</p>
        <OutcomeFields detail={detail} reload={reload} />
      </section>
      <section className="xo-card">
        <h2 className="xo-label">Key uncertainties</h2>
        {detail.questions.length === 0 ? (
          <p className="xo-empty">No strategic questions under this outcome.</p>
        ) : (
          <ul className="xo-list">
            {detail.questions.map((q) => (
              <li key={q.id}>
                <Link href="/questions">{q.label ?? q.title}</Link>
                <span className="xo-attn-detail">
                  {q.status}
                  {q.nextAction ? ` · next: ${q.nextAction}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {detail.blockedTasks.length > 0 && (
        <section className="xo-card">
          <h2 className="xo-label">Blocked work ({detail.blockedTasks.length})</h2>
          <ul className="xo-list">
            {detail.blockedTasks.map((t) => (
              <li key={t.id}>
                <Link href={`/tasks/${t.id}`}>{t.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// --- Milestones -------------------------------------------------------------

function MilestoneForm({
  initial,
  onSave,
  onCancel,
  busy,
  error,
  isAdmin,
}: {
  initial?: MilestoneDetail;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
  isAdmin: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [criteria, setCriteria] = useState(initial?.successCriteria ?? "");
  const [owner, setOwner] = useState(initial?.owner ?? "");
  const [baseline, setBaseline] = useState(day(initial?.baselineDate ?? null));
  const [forecast, setForecast] = useState(day(initial?.forecastDate ?? null));
  const [confidence, setConfidence] = useState<Confidence>(initial?.confidence ?? "unconfirmed");
  const baselineLocked = !!initial?.baselineDate && !isAdmin;
  return (
    <div className="xo-form">
      <Field label="Milestone">
        <input className="edit-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sampling acceptance criteria agreed" />
      </Field>
      <Field label="Done when (success criteria)">
        <input className="edit-input" value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      </Field>
      <Field label="Owner">
        <input className="edit-input" value={owner} onChange={(e) => setOwner(e.target.value)} />
      </Field>
      <Field label={baselineLocked ? "Baseline date (committed; only an admin can move it)" : "Baseline date (the committed plan)"}>
        <input className="edit-input" type="date" value={baseline} disabled={baselineLocked} onChange={(e) => setBaseline(e.target.value)} />
      </Field>
      <Field label="Forecast date (today's best estimate)">
        <input className="edit-input" type="date" value={forecast} onChange={(e) => setForecast(e.target.value)} />
      </Field>
      <Field label="How firm is the date?">
        <select className="edit-input" value={confidence} onChange={(e) => setConfidence(e.target.value as Confidence)}>
          <option value="committed">Committed</option>
          <option value="forecast">Forecast</option>
          <option value="unconfirmed">Unconfirmed</option>
        </select>
      </Field>
      {error && <p className="error-inline">{error}</p>}
      <div className="card-actions">
        <button
          className="decision-btn save"
          disabled={busy || !title.trim()}
          onClick={() =>
            onSave({
              title,
              successCriteria: criteria || null,
              owner: owner || null,
              ...(baselineLocked ? {} : { baselineDate: baseline || null }),
              forecastDate: forecast || null,
              confidence,
            })
          }
        >
          Save milestone
        </button>
        <button className="decision-btn cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function LinkPicker({ detail, milestone, reload }: { detail: OutcomeDetail; milestone: MilestoneDetail; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [map, setMap] = useState<CompanyMapResponse | null>(null);
  const [choice, setChoice] = useState("");
  const { busy, error, run } = useAction(reload);
  useEffect(() => {
    if (open && !map) fetchCompanyMap().then(setMap).catch(() => setMap({ objectives: [] }));
  }, [open, map]);
  if (!open) {
    return (
      <button className="link-btn" onClick={() => setOpen(true)}>
        + Link work or a decision
      </button>
    );
  }
  const objective = map?.objectives.find((o) => o.id === detail.objective.id);
  const projects = objective?.initiatives.flatMap((i) => i.projects) ?? [];
  const linked = new Set(milestone.links.map((l) => `${l.entityType}:${l.entityId}`));
  return (
    <div className="xo-form">
      <Field label="What this milestone depends on">
        <select className="edit-input" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">{map ? "Choose…" : "Loading…"}</option>
          {detail.decisions.length > 0 && (
            <optgroup label="Decisions for this outcome">
              {detail.decisions
                .filter((d) => !linked.has(`decision:${d.id}`))
                .map((d) => (
                  <option key={d.id} value={`decision:${d.id}`}>
                    {d.title}
                  </option>
                ))}
            </optgroup>
          )}
          {projects.map((p) => (
            <optgroup key={p.id} label={p.title}>
              {!linked.has(`project:${p.id}`) && <option value={`project:${p.id}`}>The whole project: {p.title}</option>}
              {p.tasks
                .filter((t) => !linked.has(`task:${t.id}`))
                .map((t) => (
                  <option key={t.id} value={`task:${t.id}`}>
                    {t.title} ({t.status.replace("_", " ")})
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {error && <p className="error-inline">{error}</p>}
      <div className="card-actions">
        <button
          className="decision-btn save"
          disabled={busy || !choice}
          onClick={() => {
            const [entityType, entityId] = choice.split(":") as ["task" | "decision" | "project", string];
            run(() => linkMilestone(milestone.id, { entityType, entityId }), () => {
              setChoice("");
              setOpen(false);
            });
          }}
        >
          Link
        </button>
        <button className="decision-btn cancel" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const STATE_LABEL = { planned: "Planned", achieved: "Achieved", missed: "Missed", dropped: "Dropped" } as const;

function MilestoneCard({ detail, m, reload, isAdmin }: { detail: OutcomeDetail; m: MilestoneDetail; reload: () => Promise<void>; isAdmin: boolean }) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction(reload);
  const slip = m.forecastDate && m.baselineDate ? Math.round((Date.parse(m.forecastDate) - Date.parse(m.baselineDate)) / 86400000) : null;
  if (editing) {
    return (
      <div className="xo-card">
        <MilestoneForm initial={m} isAdmin={isAdmin} busy={busy} error={error} onCancel={() => setEditing(false)} onSave={(body) => run(() => updateMilestone(m.id, body), () => setEditing(false))} />
      </div>
    );
  }
  return (
    <article className={`xo-card xo-ms xo-ms-${m.state}`}>
      <div className="xo-row-between">
        <h3 className="xo-outcome-title">{m.title}</h3>
        <span className="xo-chip">
          {STATE_LABEL[m.state]}
          {m.state === "planned" ? ` · ${m.confidence}` : ""}
        </span>
      </div>
      {m.successCriteria && <p className="xo-why">Done when: {m.successCriteria}</p>}
      <dl className="xo-kv">
        <dt>Baseline</dt>
        <dd>{formatDay(day(m.baselineDate)) || <span className="xo-missing">not committed</span>}</dd>
        <dt>Forecast</dt>
        <dd>
          {formatDay(day(m.forecastDate)) || "—"}
          {slip && slip > 0 ? <span className="xo-flag"> · {slip} days later than baseline</span> : ""}
        </dd>
        {m.actualDate && (
          <>
            <dt>Achieved</dt>
            <dd>{formatDay(day(m.actualDate))}</dd>
          </>
        )}
        <dt>Owner</dt>
        <dd>{m.owner ?? <span className="xo-missing">not assigned</span>}</dd>
      </dl>
      <p className="xo-label xo-label-sm">Depends on</p>
      {m.links.length === 0 ? (
        <p className="xo-empty">Nothing linked yet.</p>
      ) : (
        <ul className="xo-list">
          {m.links.map((l) => (
            <li key={l.id}>
              <Link href={l.entityType === "task" ? `/tasks/${l.entityId}` : l.entityType === "project" ? `/projects/${l.entityId}` : decisionHref(l.entityId)}>{l.title}</Link>{" "}
              <span className={l.status === "blocked" ? "xo-flag" : "xo-meta"}>
                {l.entityType} · {l.status.replace("_", " ")}
              </span>{" "}
              <button className="link-btn" disabled={busy} onClick={() => run(() => unlinkMilestone(m.id, l.id))}>
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      <LinkPicker detail={detail} milestone={m} reload={reload} />
      {error && <p className="error-inline">{error}</p>}
      <div className="card-actions">
        <button className="decision-btn" onClick={() => setEditing(true)}>
          Edit
        </button>
        {m.state === "planned" && (
          <>
            <button className="decision-btn approve" disabled={busy} onClick={() => run(() => updateMilestone(m.id, { state: "achieved" }))}>
              Mark achieved
            </button>
            <button className="decision-btn" disabled={busy} onClick={() => run(() => updateMilestone(m.id, { state: "missed" }))}>
              Mark missed
            </button>
            <button
              className="decision-btn reject"
              disabled={busy}
              onClick={() => window.confirm("Drop this milestone? It's kept for history but leaves the roadmap.") && run(() => updateMilestone(m.id, { state: "dropped" }))}
            >
              Drop
            </button>
          </>
        )}
        {m.state !== "planned" && (
          <button className="decision-btn" disabled={busy} onClick={() => run(() => updateMilestone(m.id, { state: "planned" }))}>
            Reopen
          </button>
        )}
      </div>
    </article>
  );
}

function Milestones({ detail, reload, isAdmin }: { detail: OutcomeDetail; reload: () => Promise<void>; isAdmin: boolean }) {
  const [adding, setAdding] = useState(false);
  const { busy, error, run } = useAction(reload);
  const shown = detail.milestones.filter((m) => m.state !== "dropped");
  const dropped = detail.milestones.length - shown.length;
  return (
    <div className="xo-stack">
      {adding ? (
        <div className="xo-card">
          <MilestoneForm isAdmin={isAdmin} busy={busy} error={error} onCancel={() => setAdding(false)} onSave={(body) => run(() => createMilestone({ ...body, objectiveId: detail.objective.id }), () => setAdding(false))} />
        </div>
      ) : (
        <div>
          <button className="decision-btn" onClick={() => setAdding(true)}>
            + Add milestone
          </button>
        </div>
      )}
      {shown.length === 0 && !adding && <p className="xo-empty xo-card">No milestones yet. Add the few dated checkpoints a senior leader should track for this outcome.</p>}
      {shown.map((m) => (
        <MilestoneCard key={m.id} detail={detail} m={m} reload={reload} isAdmin={isAdmin} />
      ))}
      {dropped > 0 && <p className="xo-meta">{dropped} dropped milestone{dropped === 1 ? "" : "s"} kept for history.</p>}
    </div>
  );
}

// --- Decisions --------------------------------------------------------------

function DecisionRow({ d, reload }: { d: OutcomeDetail["decisions"][number]; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [recommendation, setRecommendation] = useState(d.recommendation ?? "");
  const [impact, setImpact] = useState(d.impactOfDelay ?? "");
  const { busy, error, run } = useAction(reload);
  return (
    <li>
      <Link href={decisionHref(d.id)}>
        <strong>{d.title}</strong>
      </Link>
      <span className="xo-attn-detail">
        {d.decider} · {d.status.replace("_", " ")}
        {d.dueDate ? ` · due ${formatDay(day(d.dueDate))}` : " · no due date"}
        <br />
        {d.recommendation ? `Recommendation: ${d.recommendation}` : "No recommendation recorded"}
        {d.impactOfDelay ? ` · If delayed: ${d.impactOfDelay}` : ""}
      </span>
      {editing ? (
        <div className="xo-form">
          <Field label="Recommendation">
            <input className="edit-input" value={recommendation} onChange={(e) => setRecommendation(e.target.value)} />
          </Field>
          <Field label="What happens if it's delayed">
            <input className="edit-input" value={impact} onChange={(e) => setImpact(e.target.value)} />
          </Field>
          {error && <p className="error-inline">{error}</p>}
          <div className="card-actions">
            <button
              className="decision-btn save"
              disabled={busy}
              onClick={() => run(() => updateDecisionOverview(d.id, { recommendation: recommendation || null, impactOfDelay: impact || null }), () => setEditing(false))}
            >
              Save
            </button>
            <button className="decision-btn cancel" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="card-actions">
          <button className="link-btn" onClick={() => setEditing(true)}>
            Edit recommendation
          </button>
          <button className="link-btn" disabled={busy} onClick={() => run(() => updateDecisionOverview(d.id, { objectiveId: null }))}>
            Remove from this outcome
          </button>
        </div>
      )}
      {!editing && error && <p className="error-inline">{error}</p>}
    </li>
  );
}

function Decisions({ detail, reload }: { detail: OutcomeDetail; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<Decision[] | null>(null);
  const [choice, setChoice] = useState("");
  const { busy, error, run } = useAction(reload);
  useEffect(() => {
    if (open && !all) fetchOpenDecisions("live").then(setAll).catch(() => setAll([]));
  }, [open, all]);
  const attached = new Set(detail.decisions.map((d) => d.id));
  return (
    <div className="xo-stack">
      <section className="xo-card">
        <h2 className="xo-label">Decisions for this outcome</h2>
        {detail.decisions.length === 0 ? (
          <p className="xo-empty">No decisions attached. Attach the open decisions that affect this outcome so they reach the overview.</p>
        ) : (
          <ul className="xo-list">
            {detail.decisions.map((d) => (
              <DecisionRow key={d.id} d={d} reload={reload} />
            ))}
          </ul>
        )}
        {open ? (
          <div className="xo-form">
            <Field label="Attach an open decision">
              <select className="edit-input" value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">{all ? "Choose…" : "Loading…"}</option>
                {(all ?? [])
                  .filter((d) => !attached.has(d.id))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
              </select>
            </Field>
            {error && <p className="error-inline">{error}</p>}
            <div className="card-actions">
              <button
                className="decision-btn save"
                disabled={busy || !choice}
                onClick={() => run(() => updateDecisionOverview(choice, { objectiveId: detail.objective.id }), () => {
                  setChoice("");
                  setOpen(false);
                })}
              >
                Attach
              </button>
              <button className="decision-btn cancel" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="decision-btn" onClick={() => setOpen(true)}>
            + Attach a decision
          </button>
        )}
      </section>
    </div>
  );
}

// --- Risks ------------------------------------------------------------------

function RiskForm({ detail, initial, onDone, reload }: { detail: OutcomeDetail; initial?: RiskDetail; onDone: () => void; reload: () => Promise<void> }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [impact, setImpact] = useState(initial?.impact ?? "");
  const [likelihood, setLikelihood] = useState(initial?.likelihood ?? "");
  const [mitigation, setMitigation] = useState(initial?.mitigation ?? "");
  const [owner, setOwner] = useState(initial?.owner ?? "");
  const [nextReview, setNextReview] = useState(day(initial?.nextReviewAt ?? null));
  const [escalation, setEscalation] = useState(initial?.escalation ?? "watching");
  const [milestoneId, setMilestoneId] = useState(initial?.milestoneId ?? "");
  const { busy, error, run } = useAction(reload);
  const body = {
    title,
    impact: impact || null,
    likelihood: likelihood || null,
    mitigation: mitigation || null,
    owner: owner || null,
    nextReviewAt: nextReview || null,
    escalation,
    milestoneId: milestoneId || null,
  };
  return (
    <div className="xo-form">
      <Field label="Risk">
        <input className="edit-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Single supplier for aged domes" />
      </Field>
      <Field label="Impact if it happens">
        <input className="edit-input" value={impact} onChange={(e) => setImpact(e.target.value)} />
      </Field>
      <Field label="Likelihood (optional)">
        <input className="edit-input" value={likelihood} onChange={(e) => setLikelihood(e.target.value)} placeholder="low / medium / high" />
      </Field>
      <Field label="Mitigation">
        <input className="edit-input" value={mitigation} onChange={(e) => setMitigation(e.target.value)} />
      </Field>
      <Field label="Owner">
        <input className="edit-input" value={owner} onChange={(e) => setOwner(e.target.value)} />
      </Field>
      <Field label="Affects milestone (optional)">
        <select className="edit-input" value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
          <option value="">None</option>
          {detail.milestones
            .filter((m) => m.state !== "dropped")
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Next review">
        <input className="edit-input" type="date" value={nextReview} onChange={(e) => setNextReview(e.target.value)} />
      </Field>
      <Field label="Escalation">
        <select className="edit-input" value={escalation} onChange={(e) => setEscalation(e.target.value as "watching" | "decision_needed")}>
          <option value="watching">Watching</option>
          <option value="decision_needed">Decision needed</option>
        </select>
      </Field>
      {error && <p className="error-inline">{error}</p>}
      <div className="card-actions">
        <button
          className="decision-btn save"
          disabled={busy || !title.trim()}
          onClick={() => run(() => (initial ? updateRisk(initial.id, body) : createRisk({ ...body, objectiveId: detail.objective.id })), onDone)}
        >
          Save risk
        </button>
        <button className="decision-btn cancel" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RiskCard({ detail, r, reload }: { detail: OutcomeDetail; r: RiskDetail; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction(reload);
  if (editing) {
    return (
      <div className="xo-card">
        <RiskForm detail={detail} initial={r} reload={reload} onDone={() => setEditing(false)} />
      </div>
    );
  }
  const milestone = detail.milestones.find((m) => m.id === r.milestoneId);
  return (
    <article className="xo-card">
      <div className="xo-row-between">
        <h3 className="xo-outcome-title">{r.title}</h3>
        <span className={`xo-chip ${r.escalation === "decision_needed" ? "xo-flag" : ""}`}>{r.status === "closed" ? "Closed" : r.escalation === "decision_needed" ? "Decision needed" : "Watching"}</span>
      </div>
      <dl className="xo-kv">
        <dt>Impact</dt>
        <dd>{r.impact ?? <span className="xo-missing">not described</span>}</dd>
        {r.likelihood && (
          <>
            <dt>Likelihood</dt>
            <dd>{r.likelihood}</dd>
          </>
        )}
        <dt>Mitigation</dt>
        <dd>{r.mitigation ?? <span className="xo-missing">none recorded</span>}</dd>
        <dt>Affects</dt>
        <dd>{milestone?.title ?? "No specific milestone"}</dd>
        <dt>Owner</dt>
        <dd>{r.owner ?? <span className="xo-missing">not assigned</span>}</dd>
        <dt>Next review</dt>
        <dd>{formatDay(day(r.nextReviewAt)) || "—"}</dd>
      </dl>
      {error && <p className="error-inline">{error}</p>}
      <div className="card-actions">
        <button className="decision-btn" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button className="decision-btn" disabled={busy} onClick={() => run(() => updateRisk(r.id, { status: r.status === "open" ? "closed" : "open" }))}>
          {r.status === "open" ? "Close risk" : "Reopen"}
        </button>
      </div>
    </article>
  );
}

function Risks({ detail, reload }: { detail: OutcomeDetail; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const open = detail.risks.filter((r) => r.status === "open");
  const closed = detail.risks.filter((r) => r.status === "closed");
  return (
    <div className="xo-stack">
      {adding ? (
        <div className="xo-card">
          <RiskForm detail={detail} reload={reload} onDone={() => setAdding(false)} />
        </div>
      ) : (
        <div>
          <button className="decision-btn" onClick={() => setAdding(true)}>
            + Add risk
          </button>
        </div>
      )}
      {open.length === 0 && !adding && <p className="xo-empty xo-card">No open risks recorded for this outcome.</p>}
      {open.map((r) => (
        <RiskCard key={r.id} detail={detail} r={r} reload={reload} />
      ))}
      {closed.length > 0 && (
        <details className="xo-details">
          <summary>Closed risks ({closed.length})</summary>
          {closed.map((r) => (
            <RiskCard key={r.id} detail={detail} r={r} reload={reload} />
          ))}
        </details>
      )}
    </div>
  );
}

// --- Work -------------------------------------------------------------------

function Work({ detail }: { detail: OutcomeDetail }) {
  return (
    <section className="xo-card">
      <h2 className="xo-label">Work under this outcome ({detail.openTaskTotal} open tasks)</h2>
      {detail.work.length === 0 ? (
        <p className="xo-empty">No initiatives filed here yet.</p>
      ) : (
        <ul className="xo-list">
          {detail.work.map((i) => (
            <li key={i.id}>
              <Link href={`/initiatives/${i.id}`}>
                <strong>{i.title}</strong>
              </Link>
              {i.projects.length === 0 ? (
                <span className="xo-attn-detail">No projects yet</span>
              ) : (
                <span className="xo-attn-detail">
                  {i.projects.map((p, n) => (
                    <span key={p.id}>
                      {n > 0 && " · "}
                      <Link href={`/projects/${p.id}`}>{p.title}</Link> ({p.openTasks} open)
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Link className="xo-more" href="/company-map">
        Open the Company Map →
      </Link>
    </section>
  );
}

// --- Page -------------------------------------------------------------------

export default function OutcomePage() {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [detail, setDetail] = useState<OutcomeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("summary");

  const reload = useCallback(async () => {
    try {
      setDetail(await fetchOutcome(id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load this outcome");
    }
  }, [id]);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
    const fromHash = window.location.hash.slice(1) as Tab;
    if (TABS.some(([t]) => t === fromHash)) setTab(fromHash);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") reload();
  }, [user, reload]);

  function choose(t: Tab) {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  }

  if (user === "loading") return <main className="page" />;
  if (!user) {
    return (
      <main className="page">
        <Nav user={null} />
        <p>
          Please <Link href="/">sign in</Link>.
        </p>
      </main>
    );
  }

  return (
    <main className="page xo-page">
      <Nav user={user} />
      <p>
        <Link href="/overview">← Executive overview</Link>
      </p>
      {error && <p className="error-inline">{error}</p>}
      {!detail && !error && <p className="muted">Loading…</p>}
      {detail && (
        <>
          <header className="xo-header">
            <div>
              <h1 className="xo-h1">{detail.objective.title}</h1>
              <p className="xo-sub">
                <HealthBadge health={detail.objective.health} /> · Owner: {detail.objective.owner ?? "not assigned"}
              </p>
            </div>
          </header>
          <div className="xo-tabs" role="tablist">
            {TABS.map(([t, label]) => (
              <button key={t} role="tab" type="button" aria-selected={tab === t} className={tab === t ? "xo-on" : ""} onClick={() => choose(t)}>
                {label}
                {t === "milestones" && detail.milestones.length > 0 && ` (${detail.milestones.filter((m) => m.state !== "dropped").length})`}
                {t === "risks" && detail.risks.some((r) => r.status === "open") && ` (${detail.risks.filter((r) => r.status === "open").length})`}
                {t === "decisions" && detail.decisions.length > 0 && ` (${detail.decisions.length})`}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === "summary" && <Summary detail={detail} reload={reload} />}
            {tab === "milestones" && <Milestones detail={detail} reload={reload} isAdmin={user.role === "admin"} />}
            {tab === "decisions" && <Decisions detail={detail} reload={reload} />}
            {tab === "risks" && <Risks detail={detail} reload={reload} />}
            {tab === "work" && <Work detail={detail} />}
          </div>
        </>
      )}
    </main>
  );
}
