"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchProject,
  type ProjectDetailResponse,
  type SessionUser,
} from "../../../lib/api";
import { Nav } from "../../components/Nav";
import { TaskStatusChips } from "../../components/TaskStatusChips";

const SNIPPET_LENGTH = 100;

function snippet(text: string | null): string | null {
  if (!text) return null;
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text;
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<ProjectDetailResponse | "not_found" | "loading">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchProject(id)
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
            <h1>Project not found</h1>
          </div>
          <p className="empty-state">
            This project doesn&rsquo;t exist, or you don&rsquo;t have access to it. <Link href="/">Back to strategy map</Link>
          </p>
        </>
      )}

      {data !== "loading" && data !== "not_found" && (
        <>
          {data.initiative && (
            <p className="breadcrumb">
              <Link href="/">Strategy map</Link> / <Link href={`/initiatives/${data.initiative.id}`}>{data.initiative.title}</Link>
            </p>
          )}

          <div className="header">
            <h1>{data.project.title}</h1>
          </div>

          <article className="card">
            <div className="card-top">
              <div>{data.project.description && <span className="muted">{data.project.description}</span>}</div>
              <div className="card-badges">
                <span className="badge">{data.project.status}</span>
              </div>
            </div>

            <TaskStatusChips counts={data.taskCounts} />
          </article>

          <h2 className="section-title">Tasks</h2>

          {data.tasks.length === 0 && <p className="empty-state">No tasks yet.</p>}

          {data.tasks.map((task) => (
            <Link className="card-link" href={`/tasks/${task.id}`} key={task.id}>
              <article className="card">
                <div className="card-top">
                  <p className="card-title">{task.title}</p>
                  <div className="card-badges">
                    <span className="badge">{task.status}</span>
                  </div>
                </div>
                {snippet(task.latestUpdate) && (
                  <p className="task-snippet">
                    <span className="task-snippet-label">Latest:</span> {snippet(task.latestUpdate)}
                  </p>
                )}
                {snippet(task.nextAction) && (
                  <p className="task-snippet">
                    <span className="task-snippet-label">Next:</span> {snippet(task.nextAction)}
                  </p>
                )}
              </article>
            </Link>
          ))}
        </>
      )}
    </main>
  );
}
