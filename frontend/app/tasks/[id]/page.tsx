"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { API_URL, fetchCurrentUser, fetchTask, type SessionUser, type TaskDetailResponse } from "../../../lib/api";
import { Nav } from "../../components/Nav";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<TaskDetailResponse | "not_found" | "loading">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchTask(id)
        .then(setData)
        .catch((err) => setLoadError(err.message));
    }
  }, [user, id]);

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
        <p>Sign in with your Exvade Google account to see the strategy map.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  return (
    <main className="page">
      <Nav user={user} />

      {loadError && <div className="error-banner">{loadError}</div>}

      {data === "loading" && <p className="muted">Loading&hellip;</p>}

      {data === "not_found" && (
        <>
          <div className="header">
            <h1>Task not found</h1>
          </div>
          <p className="empty-state">
            This task doesn&rsquo;t exist, or you don&rsquo;t have access to it. <Link href="/">Back to strategy map</Link>
          </p>
        </>
      )}

      {data !== "loading" && data !== "not_found" && (
        <>
          {(data.objective || data.initiative || data.project) && (
            <p className="breadcrumb">
              <Link href="/">Strategy map</Link>
              {data.objective && (
                <>
                  {" / "}
                  <Link href={`/objectives/${data.objective.id}`}>{data.objective.title}</Link>
                </>
              )}
              {data.initiative && (
                <>
                  {" / "}
                  <Link href={`/initiatives/${data.initiative.id}`}>{data.initiative.title}</Link>
                </>
              )}
              {data.project && (
                <>
                  {" / "}
                  <Link href={`/projects/${data.project.id}`}>{data.project.title}</Link>
                </>
              )}
            </p>
          )}

          <div className="header">
            <h1>{data.task.title}</h1>
          </div>

          <article className="card">
            <div className="card-top">
              <div>{data.task.description && <span className="muted">{data.task.description}</span>}</div>
              <div className="card-badges">
                <span className="badge">{data.task.status}</span>
              </div>
            </div>

            {data.task.latestUpdate && (
              <div className="decision-sections">
                <div>
                  <p className="decision-section-label">Latest update</p>
                  <p className="decision-section-body">{data.task.latestUpdate}</p>
                </div>
              </div>
            )}

            {data.task.nextAction && (
              <div className="decision-sections">
                <div>
                  <p className="decision-section-label">Next action</p>
                  <p className="decision-section-body">{data.task.nextAction}</p>
                </div>
              </div>
            )}
          </article>

          {data.approvedSuggestions.length > 0 && (
            <>
              <h2 className="section-title">Approved suggestions</h2>
              {data.approvedSuggestions.map((s) => (
                <article className="card" key={s.id}>
                  <p className="card-title">{s.reasoning}</p>
                  <p className="muted">
                    {s.changeType} &middot; {formatDate(s.reviewedAt)}
                  </p>
                </article>
              ))}
            </>
          )}
        </>
      )}
    </main>
  );
}
