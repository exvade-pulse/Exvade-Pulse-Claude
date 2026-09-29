"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  checkContradictions,
  fetchExecutiveReview,
  markExecutiveReviewReviewed,
  runCleanup,
  type ExecutiveReviewData,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";
import { ChatGptReviewPanel } from "../components/ChatGptReviewPanel";
import { ContradictionCard, DecisionCard, QuestionCard, TaskRow, WorkstreamCard } from "../components/ReviewCards";
import { TaskDisposition } from "../components/TaskDisposition";

// Long lists show their top items; the rest sit behind "Show all" so the
// page stays scannable in under a minute.
const WORKSTREAM_PREVIEW = 6;
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
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

  async function handleCleanup() {
    setCleaning(true);
    setCleanupResult(null);
    try {
      const { recordsChecked, proposals } = await runCleanup();
      setCleanupResult(
        recordsChecked === 0
          ? "Nothing to clean up."
          : `Checked ${recordsChecked} record${recordsChecked === 1 ? "" : "s"} — ${proposals} proposal${proposals === 1 ? "" : "s"} waiting in Review.`,
      );
    } catch (err) {
      setCleanupResult(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setCleaning(false);
    }
  }

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

  async function handleCheckContradictions() {
    setChecking(true);
    setCheckResult(null);
    try {
      const { recordsChecked, contradictionsFound } = await checkContradictions();
      setCheckResult(
        `Checked ${recordsChecked} record${recordsChecked === 1 ? "" : "s"} — found ${contradictionsFound} new conflict${contradictionsFound === 1 ? "" : "s"}.`,
      );
      const refreshed = await fetchExecutiveReview();
      setData(refreshed.data);
    } catch (err) {
      setCheckResult(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setChecking(false);
    }
  }

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

  const workstreams = data ? (showAllOperating ? data.workstreams : data.workstreams.slice(0, WORKSTREAM_PREVIEW)) : [];

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

          {data.focus.length > 0 && (
            <section className="card exec-focus" aria-label="Focus">
              <p className="exec-headline-title">Focus</p>
              <ol>
                {data.focus.map((f) => (
                  <li key={`${f.kind}-${f.title}`}>
                    <strong>{f.title}</strong> <span className="muted">— {f.detail}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

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

          <h2 className="section-title">Conflicts detected</h2>
          {data.contradictions.length === 0 ? (
            <p className="empty-inline">No known conflicts between newer and older information.</p>
          ) : (
            data.contradictions.map((c) => <ContradictionCard key={c.suggestionId} contradiction={c} />)
          )}
          <div className="card-actions exec-check-row">
            <button className="decision-btn" disabled={checking} onClick={handleCheckContradictions}>
              {checking ? "Checking…" : "Check for contradictions"}
            </button>
            {checkResult && <span className="muted">{checkResult}</span>}
          </div>

          <h2 className="section-title">Strategic questions</h2>
          {data.questions.length === 0 ? (
            <p className="empty-inline">
              No strategic questions yet. <Link href="/questions">Set them up in Questions</Link> (the AI can suggest a first set).
            </p>
          ) : (
            data.questions.map((q) => <QuestionCard key={q.id} question={q} />)
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

          <h2 className="section-title">Workstreams</h2>
          {data.workstreams.length === 0 ? (
            <p className="empty-inline">No active work with recent evidence.</p>
          ) : (
            <>
              {workstreams.map((w) => (
                <WorkstreamCard key={`${w.objective}-${w.project}`} workstream={w} />
              ))}
              {data.workstreams.length > WORKSTREAM_PREVIEW && (
                <button className="text-btn" onClick={() => setShowAllOperating((v) => !v)}>
                  {showAllOperating ? "Show fewer" : `Show all ${data.workstreams.length} workstreams`}
                </button>
              )}
            </>
          )}

          <h2 className="section-title">Needs disposition</h2>
          <div className="card-actions exec-check-row">
            <button className="decision-btn" disabled={cleaning} onClick={handleCleanup}>
              {cleaning ? "Checking…" : "Clean up stale records"}
            </button>
            {cleanupResult && <span className="muted">{cleanupResult}</span>}
          </div>
          {data.needsDisposition.length === 0 ? (
            <p className="empty-inline">
              No old records. The cleanup check also reviews next actions that may be out of date.
            </p>
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
