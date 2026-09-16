"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchWeeklyReport,
  type SessionUser,
  type WeeklyReport,
} from "../../../lib/api";
import { Nav } from "../../components/Nav";

const SNIPPET_LENGTH = 100;

function snippet(text: string | null): string | null {
  if (!text) return null;
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text;
}

// Every date in a WeeklyReport is a plain YYYY-MM-DD string (see
// backend/src/routes/reports.ts) -- parsed as UTC and formatted in UTC so the
// displayed day never shifts a day off because of the viewer's local
// timezone.
function formatDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00.000Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parentChain(entry: { objective: { title: string }; initiative: { title: string }; project: { title: string } }): string {
  return [entry.objective.title, entry.initiative.title, entry.project.title].join(" › ");
}

function buildPlainTextReport(report: WeeklyReport): string {
  const lines: string[] = [];
  lines.push(`Weekly Report: ${formatDate(report.weekStart)} - ${formatDate(report.weekEnd)}`);
  lines.push(`${report.taskCount} task${report.taskCount === 1 ? "" : "s"} with meaningful changes`);
  lines.push("");

  lines.push("DECISIONS NEEDED");
  if (report.decisionsNeeded.length === 0) {
    lines.push("None.");
  } else {
    for (const d of report.decisionsNeeded) {
      const due = d.dueDate ? `, due ${formatDate(d.dueDate.slice(0, 10))}` : "";
      lines.push(`- ${d.title} (decider: ${d.decider}${due})`);
    }
  }
  lines.push("");

  lines.push("BLOCKERS");
  if (report.blockers.length === 0) {
    lines.push("None.");
  } else {
    for (const b of report.blockers) {
      const owner = b.owner ? ` (owner: ${b.owner})` : "";
      lines.push(`- ${b.title}${owner} -- ${parentChain(b)}`);
    }
  }
  lines.push("");

  if (report.workstreams.length === 0) {
    lines.push("No workstreams had meaningful task updates this week.");
    lines.push("");
  } else {
    for (const ws of report.workstreams) {
      lines.push(ws.objectiveTitle.toUpperCase());
      for (const t of ws.tasks) {
        const owner = t.owner ? ` (owner: ${t.owner})` : "";
        const cite = t.sourceCount > 0 ? ` [${t.sourceCount} source${t.sourceCount === 1 ? "" : "s"}]` : "";
        lines.push(`- ${t.title}${owner}${cite}`);
        if (t.latestUpdate) lines.push(`    Latest: ${t.latestUpdate}`);
        if (t.nextAction) lines.push(`    Next: ${t.nextAction}`);
      }
      lines.push("");
    }
  }

  lines.push("SOURCES");
  if (report.sources.length === 0) {
    lines.push("None.");
  } else {
    for (const s of report.sources) {
      lines.push(`- [${s.type}] ${s.externalId} -- received ${formatDate(s.receivedAt.slice(0, 10))}`);
    }
  }

  return lines.join("\n");
}

export default function WeeklyReportPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [weekOf, setWeekOf] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchWeeklyReport(weekOf)
        .then((res) => {
          setReport(res);
          setLoadError(null);
        })
        .catch((err) => setLoadError(err.message));
    }
  }, [user, weekOf]);

  const goToWeek = useCallback((anchor: string) => {
    setWeekOf(anchor);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(buildPlainTextReport(report));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to copy report");
    }
  }, [report]);

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
        <p>Sign in with your Exvade Google account to see the weekly report.</p>
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
        <h1>Weekly report</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {report && (
        <>
          <div className="report-toolbar">
            <div className="report-range">
              <button className="tab-btn" onClick={() => goToWeek(addDays(report.weekStart, -7))}>
                &larr; Prev week
              </button>
              <span className="report-range-label">
                {formatDate(report.weekStart)} &ndash; {formatDate(report.weekEnd)} &middot; {report.taskCount} task
                {report.taskCount === 1 ? "" : "s"} with meaningful changes
              </span>
              <button className="tab-btn" onClick={() => goToWeek(addDays(report.weekEnd, 1))}>
                Next week &rarr;
              </button>
            </div>
            <button className="signin-btn" onClick={handleCopy}>
              {copied ? "Copied" : "Copy report"}
            </button>
          </div>

          <h2 className="section-title">Decisions needed</h2>
          {report.decisionsNeeded.length === 0 ? (
            <p className="empty-state">None.</p>
          ) : (
            <div className="card task-list">
              {report.decisionsNeeded.map((d) => (
                <div className="task-row" key={d.id}>
                  <div className="task-row-top">
                    <Link className="task-row-title" href="/decisions">
                      {d.title}
                    </Link>
                    {d.dueDate && <span className="muted">Due {formatDate(d.dueDate.slice(0, 10))}</span>}
                  </div>
                  <p className="task-row-meta">Decider: {d.decider}</p>
                </div>
              ))}
            </div>
          )}

          <h2 className="section-title">Blockers</h2>
          {report.blockers.length === 0 ? (
            <p className="empty-state">None.</p>
          ) : (
            <div className="card task-list">
              {report.blockers.map((b) => (
                <div className="task-row" key={b.id}>
                  <div className="task-row-top">
                    <Link className="task-row-title" href={`/tasks/${b.id}`}>
                      {b.title}
                    </Link>
                  </div>
                  <p className="task-row-meta">
                    {b.owner && <>Owner: {b.owner} &middot; </>}
                    {parentChain(b)}
                  </p>
                </div>
              ))}
            </div>
          )}

          <h2 className="section-title">Workstreams</h2>
          {report.workstreams.length === 0 ? (
            <p className="empty-state">No workstreams had meaningful task updates this week.</p>
          ) : (
            report.workstreams.map((ws) => (
              <article className="card" key={ws.objectiveId}>
                <Link className="card-title card-title-link" href={`/objectives/${ws.objectiveId}`}>
                  {ws.objectiveTitle}
                </Link>
                <div className="task-list">
                  {ws.tasks.map((t) => (
                    <div className="task-row" key={t.id}>
                      <div className="task-row-top">
                        <Link className="task-row-title" href={`/tasks/${t.id}`}>
                          {t.title}
                        </Link>
                        <span className="muted">
                          {t.sourceCount} source{t.sourceCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      <p className="task-row-meta">{t.owner && <>Owner: {t.owner}</>}</p>
                      {snippet(t.latestUpdate) && (
                        <p className="task-snippet">
                          <span className="task-snippet-label">Latest:</span> {snippet(t.latestUpdate)}
                        </p>
                      )}
                      {snippet(t.nextAction) && (
                        <p className="task-snippet">
                          <span className="task-snippet-label">Next:</span> {snippet(t.nextAction)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </article>
            ))
          )}

          <h2 className="section-title">Sources</h2>
          {report.sources.length === 0 ? (
            <p className="empty-state">None.</p>
          ) : (
            <div className="card task-list">
              {report.sources.map((s) => (
                <div className="task-row" key={s.id}>
                  <p className="task-row-meta">
                    [{s.type}] {s.externalId} &middot; received {formatDate(s.receivedAt.slice(0, 10))}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
