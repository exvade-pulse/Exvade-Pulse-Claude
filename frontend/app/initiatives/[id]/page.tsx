"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchInitiative,
  type InitiativeDetailResponse,
  type SessionUser,
} from "../../../lib/api";
import { Nav } from "../../components/Nav";

export default function InitiativeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<InitiativeDetailResponse | "not_found" | "loading">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchInitiative(id)
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
            <h1>Initiative not found</h1>
          </div>
          <p className="empty-state">
            This initiative doesn&rsquo;t exist, or you don&rsquo;t have access to it. <Link href="/">Back to strategy map</Link>
          </p>
        </>
      )}

      {data !== "loading" && data !== "not_found" && (
        <>
          {data.objective && (
            <p className="breadcrumb">
              <Link href="/">Strategy map</Link> / <Link href={`/objectives/${data.objective.id}`}>{data.objective.title}</Link>
            </p>
          )}

          <div className="header">
            <h1>{data.initiative.title}</h1>
          </div>

          <article className="card">
            <div className="card-top">
              <div>
                {data.initiative.description && <span className="muted">{data.initiative.description}</span>}
              </div>
              <div className="card-badges">
                <span className={`badge badge-priority-${data.initiative.priority}`}>{data.initiative.priority}</span>
                <span className="badge">{data.initiative.status}</span>
              </div>
            </div>
          </article>

          <h2 className="section-title">Projects</h2>

          {data.projects.length === 0 && <p className="empty-state">No projects yet.</p>}

          {data.projects.map((project) => (
            <Link className="card-link" href={`/projects/${project.id}`} key={project.id}>
              <article className="card">
                <div className="card-top">
                  <p className="card-title">{project.title}</p>
                  <div className="card-badges">
                    <span className="badge">{project.status}</span>
                  </div>
                </div>
              </article>
            </Link>
          ))}
        </>
      )}
    </main>
  );
}
