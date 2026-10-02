"use client";

import Link from "next/link";
import { useState } from "react";
import {
  draftNarrative,
  formatDay,
  HEALTH_ICON,
  HEALTH_LABEL,
  publishOverview,
  TREND_LABEL,
  type AttentionItem,
  type ExecutiveOverview,
  type Health,
  type Outcome,
} from "../../../lib/overview";
import { decisionHref } from "../Dashboard";

// The pieces of the Executive Overview page. Health always shows an icon and
// a word, never color alone; empty states say what's missing rather than
// implying all is well.

export const outcomeHref = (id: string) => `/overview/outcomes/${id}`;

export function HealthBadge({ health }: { health: Health }) {
  return (
    <span className={`xo-health xo-h-${health}`}>
      <span aria-hidden="true">{HEALTH_ICON[health]}</span> {HEALTH_LABEL[health]}
    </span>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function OutcomeCard({ outcome: o }: { outcome: Outcome }) {
  const next = o.nextMilestone;
  return (
    <article className="xo-card xo-outcome">
      <div className="xo-outcome-top">
        <h3 className="xo-outcome-title">
          <Link href={outcomeHref(o.id)}>{o.title}</Link>
        </h3>
        <HealthBadge health={o.health} />
      </div>
      {o.rationale ? <p className="xo-why">{o.rationale}</p> : <p className="xo-why xo-missing">Why this matters isn&apos;t written yet.</p>}
      {o.health === "not_assessed" ? (
        <p className="xo-why">
          <strong>Not assessed yet.</strong> {o.owner ? `${o.owner} to assess.` : "Needs an owner to assess it."}
        </p>
      ) : (
        o.healthRationale && (
          <p className="xo-why">
            <strong>Why {HEALTH_LABEL[o.health].toLowerCase()}:</strong> {o.healthRationale}
          </p>
        )
      )}
      {o.stale && (
        <p className="xo-warn" role="note">
          ⚠ Assessed {o.assessmentAgeDays ?? "many"} days ago. Review needed.
        </p>
      )}
      {o.assessmentMayBeOutdated && (
        <p className="xo-warn" role="note">
          ⚠ &ldquo;On track&rdquo; may be out of date: {o.signals[0]}
        </p>
      )}
      <dl className="xo-kv">
        <dt>Trend</dt>
        <dd>{TREND_LABEL[o.trend]}</dd>
        <dt>Next</dt>
        <dd>
          {next ? (
            <>
              {next.title} · {formatDay(next.date)} <span className="xo-conf">({next.confidence})</span>
            </>
          ) : (
            <span className="xo-missing">Timing not confirmed{o.undatedMilestones ? ` (${plural(o.undatedMilestones, "undated milestone")})` : ""}</span>
          )}
        </dd>
        <dt>Owner</dt>
        <dd>{o.owner ?? <span className="xo-missing">Not assigned</span>}</dd>
        <dt>Reviewed</dt>
        <dd>{o.assessedAt ? `${formatDay(o.assessedAt.slice(0, 10))}${o.assessedBy ? ` by ${o.assessedBy}` : ""}` : "Never"}</dd>
      </dl>
      {(o.decisionsNeeded > 0 || o.openRisks > 0) && (
        <p className="xo-meta">
          {[o.decisionsNeeded > 0 && plural(o.decisionsNeeded, "decision") + " needed", o.openRisks > 0 && plural(o.openRisks, "open risk")].filter(Boolean).join(" · ")}
        </p>
      )}
      <Link className="xo-more" href={outcomeHref(o.id)}>
        View outcome →
      </Link>
    </article>
  );
}

function attentionHref(item: AttentionItem): string {
  if (item.link.type === "decision") return decisionHref(item.link.id);
  if (item.link.type === "task") return `/tasks/${item.link.id}`;
  if (item.link.type === "objective") return outcomeHref(item.link.id);
  return item.objectiveId ? `${outcomeHref(item.objectiveId)}#milestones` : "/overview";
}

export function AttentionList({ items, total }: { items: AttentionItem[]; total: number }) {
  return (
    <section className="xo-card" aria-labelledby="xo-attention">
      <h2 className="xo-label" id="xo-attention">
        Leadership attention {total > 0 && `(${total})`}
      </h2>
      {items.length === 0 ? (
        <p className="xo-empty">
          Nothing flagged: no decisions due in the next 30 days, no blocked work holding up a milestone, and no outcome has worsened. This only
          covers what&apos;s recorded in Pulse.
        </p>
      ) : (
        <ol className="xo-attn">
          {items.map((item) => (
            <li key={`${item.kind}:${item.link.id}`} className={`xo-attn-item xo-attn-${item.tier <= 2 ? "high" : "mid"}`}>
              <Link href={attentionHref(item)} className="xo-attn-title">
                {item.title}
              </Link>
              <span className="xo-attn-detail">
                {item.kind === "decision" ? (
                  <>
                    Decider: {item.decider} · {item.detail}
                    <br />
                    {item.recommendation ? `Recommendation: ${item.recommendation}` : "No recommendation recorded"}
                    {item.impactOfDelay ? ` · If delayed: ${item.impactOfDelay}` : ""}
                  </>
                ) : (
                  item.detail
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {total > items.length && <p className="xo-meta">{total - items.length} more below the top three, in the outcomes they belong to.</p>}
    </section>
  );
}

export function NarrativePanel({ overview, canPublish, onPublished }: { overview: ExecutiveOverview; canPublish: boolean; onPublished: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"draft" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  async function aiDraft() {
    setBusy("draft");
    setError(null);
    try {
      setDraft((await draftNarrative()).draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get a draft");
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!window.confirm("Publish this summary? It becomes the baseline for “what changed” until the next review is published.")) return;
    setBusy("publish");
    setError(null);
    try {
      await publishOverview(draft);
      setEditing(false);
      onPublished();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't publish");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="xo-card" aria-labelledby="xo-narrative">
      <h2 className="xo-label" id="xo-narrative">
        Where we are
      </h2>
      {editing ? (
        <>
          <textarea className="edit-input xo-textarea" rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Summary paragraph" />
          <p className={`xo-meta ${words > 90 ? "xo-warn" : ""}`}>{words} words (aim for 60–90)</p>
          {error && <p className="error-inline">{error}</p>}
          <div className="card-actions">
            <button className="decision-btn" disabled={busy !== null} onClick={aiDraft}>
              {busy === "draft" ? "Drafting…" : "Draft with AI"}
            </button>
            <button className="decision-btn save" disabled={busy !== null || !draft.trim()} onClick={publish}>
              {busy === "publish" ? "Publishing…" : "Publish review"}
            </button>
            <button className="decision-btn cancel" disabled={busy !== null} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <p className="xo-meta">The AI draft uses only what&apos;s recorded in Pulse. Check it before publishing; nothing is saved until you publish.</p>
        </>
      ) : (
        <>
          {overview.narrative ? (
            <p className="xo-narrative">{overview.narrative}</p>
          ) : (
            <p className="xo-empty">No summary has been published yet.{canPublish ? " Write one and publish the first review." : ""}</p>
          )}
          {overview.period && (
            <p className="xo-meta">
              Published {formatDay(overview.period.publishedAt.slice(0, 10))} · covers {formatDay(overview.period.periodStart)} – {formatDay(overview.period.periodEnd)}
            </p>
          )}
          {canPublish && (
            <div className="card-actions">
              <button
                className="decision-btn"
                onClick={() => {
                  setDraft(overview.narrative ?? "");
                  setEditing(true);
                }}
              >
                {overview.narrative ? "Write the next review" : "Write the first review"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function MaterialChanges({ overview }: { overview: ExecutiveOverview }) {
  const changes = overview.changes;
  const label = (k: string) => (k === "health" ? "Health" : k === "milestone_date" ? "Date moved" : "Milestone");
  return (
    <section className="xo-card" aria-labelledby="xo-changes">
      <h2 className="xo-label" id="xo-changes">
        What changed {overview.period ? `since ${formatDay(overview.period.publishedAt.slice(0, 10))}` : ""}
      </h2>
      {changes === null ? (
        <p className="xo-empty">Comparison unavailable: no review has been published yet. Once one is, changes since then show here.</p>
      ) : changes.length === 0 ? (
        <p className="xo-empty">No change in outcome health or milestone dates since the last published review.</p>
      ) : (
        <ul className="xo-list">
          {changes.slice(0, 5).map((c, i) => (
            <li key={i}>
              <strong>{c.title}</strong>
              <span className="xo-attn-detail">
                {label(c.kind)}: {c.kind === "milestone_date" ? `${formatDay(c.before) || "no date"} → ${formatDay(c.after) || "no date"}` : `${c.before ?? "—"} → ${c.after ?? "—"}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {changes && changes.length > 5 && <p className="xo-meta">{changes.length - 5} more changes.</p>}
    </section>
  );
}

export function TopRisks({ overview }: { overview: ExecutiveOverview }) {
  return (
    <section className="xo-card" aria-labelledby="xo-risks">
      <h2 className="xo-label" id="xo-risks">
        Top risks {overview.openRiskTotal > 0 && `(${overview.topRisks.length} of ${overview.openRiskTotal})`}
      </h2>
      {overview.topRisks.length === 0 ? (
        <p className="xo-empty">No open risks recorded. Add them on each outcome&apos;s page.</p>
      ) : (
        <ul className="xo-list">
          {overview.topRisks.map((r) => (
            <li key={r.id}>
              <Link href={`${outcomeHref(r.objectiveId)}#risks`}>
                <strong>{r.title}</strong>
              </Link>
              <span className="xo-attn-detail">
                {[r.impact && `Impact: ${r.impact}`, r.milestoneTitle && `Affects: ${r.milestoneTitle}`].filter(Boolean).join(" · ")}
                {(r.impact || r.milestoneTitle) && <br />}
                {r.mitigation ? `Mitigation: ${r.mitigation}` : "No mitigation recorded"} · {r.owner ?? "No owner"} ·{" "}
                <span className={r.escalation === "decision_needed" ? "xo-flag" : ""}>{r.escalation === "decision_needed" ? "Decision needed" : "Watching"}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
