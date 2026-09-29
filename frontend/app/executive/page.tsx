"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchExecutiveReview,
  markExecutiveReviewReviewed,
  type ExecutiveReviewData,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";
import { ChatGptReviewPanel } from "../components/ChatGptReviewPanel";
import { DecisionCard, TaskRow } from "../components/ReviewCards";
import { TaskDisposition } from "../components/TaskDisposition";

// Long lists show their top items; the rest sit behind "Show all" so the
// page stays scannable in under a minute.
const OPERATING_PREVIEW = 8;
const DEVELOPMENTS_PREVIEW = 6;
const CHANGES_PREVIEW = 5;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function ExecutivePage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<ExecutiveReviewData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAllOperating, setShowAllOperating] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markedAt, setMarkedAt] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchExecutiveReview()
        .then((r) => setData(r.data))
        .catch((err) => setLoadError(err.message));
    }
  }, [user]);

  async function handleMarkReviewed() {
    setMarking(true);
    try {
      const { lastReviewedAt } = await markExecutiveReviewReviewed();
      setMarkedAt(lastReviewedAt);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setMarking(false);
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
        <p>Sign in with your Exvade Google account to see the executive review.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  const operating = data ? (showAllOperating ? data.operatingActions : data.operatingActions.slice(0, OPERATING_PREVIEW)) : [];

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>Executive review</h1>
        {data && (
          <div className="card-actions exec-header-actions">
            <span className="muted">As of {new Date(data.generatedAt).toLocaleString()}</span>
            <button className="decision-btn" disabled={marking || markedAt !== null} onClick={handleMarkReviewed}>
              {markedAt ? "Marked as reviewed" : marking ? "Saving…" : "Mark as reviewed"}
            </button>
          </div>
        )}
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
      {!data && !loadError && <p className="muted">Building the review&hellip;</p>}

      {data && (
        <>
          <section className="card exec-headline" aria-label="This week">
            <p className="exec-headline-title">This week</p>
            <ul>
              {data.headline.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>

          <h2 className="section-title">Since last review</h2>
          {!data.sinceLastReview ? (
            <p className="empty-inline">
              Click <strong>Mark as reviewed</strong> when you&rsquo;ve read this. Next time, this section shows only what changed
              since then.
            </p>
          ) : (
            <section className="card exec-changes" aria-label="Since last review">
              <p className="rc-meta">Since {new Date(data.sinceLastReview.lastReviewedAt).toLocaleDateString()}</p>
              {data.sinceLastReview.changes.length === 0 ? (
                <p className="rc-line">Nothing material has changed.</p>
              ) : (
                <>
                  <ul>
                    {data.sinceLastReview.changes.slice(0, CHANGES_PREVIEW).map((c) => (
                      <li key={`${c.kind}-${c.title}`}>
                        <strong>{c.title}</strong> <span className="muted">— {c.detail}</span>
                      </li>
                    ))}
                  </ul>
                  {data.sinceLastReview.changes.length > CHANGES_PREVIEW && (
                    <details className="rc-details">
                      <summary>{data.sinceLastReview.changes.length - CHANGES_PREVIEW} smaller changes</summary>
                      <ul>
                        {data.sinceLastReview.changes.slice(CHANGES_PREVIEW).map((c) => (
                          <li key={`${c.kind}-${c.title}`}>
                            {c.title} <span className="muted">— {c.detail}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </section>
          )}

          {data.deadlinePassed.length > 0 && (
            <>
              <h2 className="section-title">Deadline passed: what happened?</h2>
              {data.deadlinePassed.map((d) => (
                <DecisionCard key={d.id} decision={d} deadlinePassed />
              ))}
            </>
          )}

          <h2 className="section-title">Decisions needed</h2>
          {data.decisionsNeeded.length === 0 ? (
            <p className="empty-inline">No open decisions.</p>
          ) : (
            data.decisionsNeeded.map((d) => <DecisionCard key={d.id} decision={d} />)
          )}
          {data.decisionsInProgress.length > 0 && (
            <p className="rc-meta exec-in-progress">
              Decided and being carried out: {data.decisionsInProgress.map((d) => d.title).join(" · ")}
            </p>
          )}

          <h2 className="section-title">Risks &amp; blockers</h2>
          {data.risks.length === 0 ? (
            <p className="empty-inline">Nothing blocked, waiting or flagged.</p>
          ) : (
            <div className="card task-list">
              {data.risks.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </div>
          )}

          <h2 className="section-title">Operating actions</h2>
          {data.operatingActions.length === 0 ? (
            <p className="empty-inline">No active work with recent evidence.</p>
          ) : (
            <>
              <div className="card task-list">
                {operating.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </div>
              {data.operatingActions.length > OPERATING_PREVIEW && (
                <button className="text-btn" onClick={() => setShowAllOperating((v) => !v)}>
                  {showAllOperating ? "Show fewer" : `Show all ${data.operatingActions.length}`}
                </button>
              )}
            </>
          )}

          <h2 className="section-title">Needs disposition</h2>
          {data.needsDisposition.length === 0 ? (
            <p className="empty-inline">No stale records.</p>
          ) : (
            <details className="card exec-disposition">
              <summary>
                {data.needsDisposition.length} old record{data.needsDisposition.length === 1 ? "" : "s"} with no supporting
                evidence in 90+ days. Not urgent: close, update or confirm each is still relevant.
              </summary>
              <div className="task-list">
                {data.needsDisposition.map((t) => (
                  <TaskRow key={t.id} task={t} showWhy={false}>
                    <TaskDisposition
                      taskId={t.id}
                      status={t.status}
                      onChanged={() =>
                        setData((prev) => (prev ? { ...prev, needsDisposition: prev.needsDisposition.filter((x) => x.id !== t.id) } : prev))
                      }
                    />
                  </TaskRow>
                ))}
              </div>
            </details>
          )}

          <h2 className="section-title">Recent developments</h2>
          {data.recentDevelopments.length === 0 ? (
            <p className="empty-inline">Nothing new in the last two weeks.</p>
          ) : (
            <div className="card exec-developments">
              <ul>
                {data.recentDevelopments.slice(0, DEVELOPMENTS_PREVIEW).map((r) => (
                  <li key={r.id}>
                    <span className="exec-date">{formatDate(r.date)}</span> {r.about}{" "}
                    <span className="muted">({r.source})</span>
                  </li>
                ))}
              </ul>
              {data.recentDevelopments.length > DEVELOPMENTS_PREVIEW && (
                <details className="rc-details">
                  <summary>{data.recentDevelopments.length - DEVELOPMENTS_PREVIEW} more</summary>
                  <ul>
                    {data.recentDevelopments.slice(DEVELOPMENTS_PREVIEW).map((r) => (
                      <li key={r.id}>
                        <span className="exec-date">{formatDate(r.date)}</span> {r.about}{" "}
                        <span className="muted">({r.source})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <h2 className="section-title">Awaiting review</h2>
          <div className="card exec-review-summary">
            <p>
              {data.awaitingReviewTotal === 0
                ? "Nothing waiting for approval."
                : `${data.awaitingReviewTotal} suggested change${data.awaitingReviewTotal === 1 ? " is" : "s are"} waiting for your approval.`}
            </p>
            {data.awaitingReviewTotal > 0 && (
              <div className="card-actions">
                <Link className="decision-btn save" href="/review">
                  Open Review
                </Link>
              </div>
            )}
          </div>

          <p className="exec-counts muted">
            Reference: {data.counts.openTasks} open tasks ({data.counts.blocked} blocked, {data.counts.needsAttention} need
            attention, {data.counts.waiting} waiting) · {data.counts.openDecisions} open decisions.
          </p>

          <ChatGptReviewPanel isAdmin={user.role === "admin"} />
        </>
      )}
    </main>
  );
}
