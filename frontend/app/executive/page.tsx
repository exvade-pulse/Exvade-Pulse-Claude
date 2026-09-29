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
  type Dashboard,
  type ExecutiveReviewData,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";
import { ChatGptReviewPanel } from "../components/ChatGptReviewPanel";
import { ContradictionCard, DecisionCard, QuestionCard, TaskRow, WorkstreamCard } from "../components/ReviewCards";
import { TaskDisposition } from "../components/TaskDisposition";
import { ChangeList, ItemList, PriorityCard, shortDate } from "../components/Dashboard";

// An operating dashboard first, a database review second: priorities, what
// changed, what needs you, real dates and what's stuck up top; the detail
// and the housekeeping collapsed below.

export default function ExecutivePage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<ExecutiveReviewData | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [markedAt, setMarkedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

  async function load() {
    const r = await fetchExecutiveReview();
    setData(r.data);
    setDash(r.dashboard);
  }

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") load().catch((err) => setLoadError(err.message));
  }, [user]);

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

  async function handleCheckContradictions() {
    setChecking(true);
    setCheckResult(null);
    try {
      const { recordsChecked, contradictionsFound } = await checkContradictions();
      setCheckResult(
        `Checked ${recordsChecked} record${recordsChecked === 1 ? "" : "s"} — found ${contradictionsFound} new conflict${contradictionsFound === 1 ? "" : "s"}.`,
      );
      await load();
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

  const closeOuts = data ? data.questions.filter((q) => q.needsCloseOut) : [];
  const qualityCount = data ? data.contradictions.length + data.deadlinePassed.length : 0;
  const olderCount = data ? data.needsDisposition.length + data.decisionsInProgress.length + closeOuts.length : 0;

  return (
    <main className="page exec-page">
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
      {(!data || !dash) && !loadError && <p className="muted">Building the review&hellip;</p>}

      {data && dash && (
        <>
          <h2 className="section-title">Executive priorities</h2>
          {dash.priorities.length === 0 ? (
            <p className="empty-inline">
              No priorities yet. <Link href="/questions">Set up strategic questions</Link> (the AI can suggest a first set).
            </p>
          ) : (
            <div className="priority-grid">
              {dash.priorities.map((p) => (
                <PriorityCard key={p.id} priority={p} />
              ))}
            </div>
          )}
          {dash.priorities.some((p) => p.kind === "workstream") && (
            <p className="rc-meta">
              Some priorities are workstreams because they aren&rsquo;t part of a strategic question yet.{" "}
              <Link href="/questions">Group them into questions</Link>.
            </p>
          )}

          <div className="dash-columns">
            <section className="card dash-panel" aria-label="What changed">
              <h2 className="dash-panel-title">
                What changed <span className="muted">since {shortDate(dash.since)}</span>
              </h2>
              {dash.whatChanged.length === 0 ? <p className="empty-inline">Nothing material.</p> : <ChangeList changes={dash.whatChanged} />}
            </section>
            <section className="card dash-panel dash-panel-mine" aria-label="Needs my action">
              <h2 className="dash-panel-title">Needs my action</h2>
              <ItemList items={dash.needsMe} empty="Nothing assigned to you right now." />
            </section>
          </div>

          <div className="dash-columns">
            <section className="card dash-panel" aria-label="Upcoming deadlines">
              <h2 className="dash-panel-title">Upcoming deadlines</h2>
              {dash.upcomingDeadlines.length === 0 ? (
                <p className="empty-inline">No dated decisions in the next 90 days.</p>
              ) : (
                <ul className="dash-list">
                  {dash.upcomingDeadlines.map((u) => (
                    <li key={u.id}>
                      <span className={`dash-due${u.daysAway <= 14 ? " dash-due-soon" : ""}`}>
                        {shortDate(u.date)} <span className="muted">({u.daysAway === 0 ? "today" : `${u.daysAway}d`})</span>
                      </span>{" "}
                      <Link href="/decisions">{u.title}</Link>
                      <span className="dash-detail"> · {u.owner}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card dash-panel" aria-label="Waiting or blocked">
              <h2 className="dash-panel-title">Waiting / blocked</h2>
              <ItemList items={dash.waiting} empty="Nothing waiting or blocked." />
            </section>
          </div>

          <h2 className="section-title">Decisions</h2>
          {data.decisionsNeeded.length === 0 ? (
            <p className="empty-inline">No open decisions.</p>
          ) : (
            data.decisionsNeeded.map((d) => <DecisionCard key={d.id} decision={d} />)
          )}

          <details className="dash-section">
            <summary>
              <span className="dash-section-title">Program details</span>
              <span className="muted">
                {" "}
                · {data.questions.filter((q) => q.status === "open").length} strategic questions · {data.workstreams.length} workstreams ·{" "}
                {data.risks.length} flagged tasks
              </span>
            </summary>
            {data.questions.filter((q) => q.status === "open").length > 0 && (
              <>
                <h3 className="dash-sub">Strategic questions</h3>
                {data.questions
                  .filter((q) => q.status === "open")
                  .map((q) => (
                    <QuestionCard key={q.id} question={q} />
                  ))}
              </>
            )}
            <h3 className="dash-sub">Workstreams</h3>
            {data.workstreams.length === 0 ? (
              <p className="empty-inline">No active work with recent evidence.</p>
            ) : (
              data.workstreams.map((w) => <WorkstreamCard key={`${w.objective}-${w.project}`} workstream={w} />)
            )}
            {data.risks.length > 0 && (
              <>
                <h3 className="dash-sub">Blocked, waiting or flagged tasks</h3>
                <div className="card task-list">
                  {data.risks.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </div>
              </>
            )}
          </details>

          <details className="dash-section">
            <summary>
              <span className="dash-section-title">Older / resolved items</span>
              <span className="muted"> · {olderCount} item{olderCount === 1 ? "" : "s"}</span>
            </summary>
            {closeOuts.length > 0 && (
              <>
                <h3 className="dash-sub">Resolved questions with decisions still open</h3>
                {closeOuts.map((q) => (
                  <QuestionCard key={q.id} question={q} />
                ))}
              </>
            )}
            {data.decisionsInProgress.length > 0 && (
              <>
                <h3 className="dash-sub">Decided, being carried out</h3>
                <ul className="dash-list">
                  {data.decisionsInProgress.map((d) => (
                    <li key={d.id}>
                      <Link href="/decisions">{d.title}</Link> <span className="dash-detail">· {d.decider}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="dash-sub">No new evidence in 90+ days</h3>
            <div className="card-actions exec-check-row">
              <button className="decision-btn" disabled={cleaning} onClick={handleCleanup}>
                {cleaning ? "Checking…" : "Clean up stale records"}
              </button>
              {cleanupResult && <span className="muted">{cleanupResult}</span>}
            </div>
            {data.needsDisposition.length === 0 ? (
              <p className="empty-inline">No old records.</p>
            ) : (
              <div className="card task-list">
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
            )}
          </details>

          <details className="dash-section" open={qualityCount > 0}>
            <summary>
              <span className="dash-section-title">Data quality / conflicts</span>
              <span className="muted">
                {" "}
                · {data.contradictions.length} conflict{data.contradictions.length === 1 ? "" : "s"} · {data.deadlinePassed.length} past-deadline
                decision{data.deadlinePassed.length === 1 ? "" : "s"} · {data.awaitingReviewTotal} in Review
              </span>
            </summary>
            {data.contradictions.map((c) => (
              <ContradictionCard key={c.suggestionId} contradiction={c} />
            ))}
            <div className="card-actions exec-check-row">
              <button className="decision-btn" disabled={checking} onClick={handleCheckContradictions}>
                {checking ? "Checking…" : "Check for contradictions"}
              </button>
              {checkResult && <span className="muted">{checkResult}</span>}
            </div>
            {data.deadlinePassed.length > 0 && (
              <>
                <h3 className="dash-sub">Deadline passed: what actually happened?</h3>
                {data.deadlinePassed.map((d) => (
                  <DecisionCard key={d.id} decision={d} deadlinePassed />
                ))}
              </>
            )}
            <p className="rc-line">
              {data.awaitingReviewTotal === 0 ? (
                "Nothing waiting for approval."
              ) : (
                <>
                  {data.awaitingReviewTotal} suggested change{data.awaitingReviewTotal === 1 ? " is" : "s are"} waiting.{" "}
                  <Link href="/review">Open Review</Link>
                </>
              )}
            </p>
          </details>

          <ChatGptReviewPanel isAdmin={user.role === "admin"} />
        </>
      )}
    </main>
  );
}
