"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchObjective,
  type ObjectiveDetailResponse,
  type SessionUser,
} from "../../../lib/api";
import { Nav } from "../../components/Nav";
import { RelationshipsPanel } from "../../components/RelationshipsPanel";

export default function ObjectiveDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<ObjectiveDetailResponse | "not_found" | "loading">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchObjective(id)
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
            <h1>Objective not found</h1>
          </div>
          <p className="empty-state">
            This objective doesn&rsquo;t exist, or you don&rsquo;t have access to it. <Link href="/">Back to strategy map</Link>
          </p>
        </>
      )}

      {data !== "loading" && data !== "not_found" && (
        <>
          <div className="header">
            <h1>{data.objective.title}</h1>
          </div>

          <article className="card">
            <div className="card-top">
              <div>
                {data.objective.description && <span className="muted">{data.objective.description}</span>}
                {data.objective.owner && <span className="owner-line">Owner: {data.objective.owner}</span>}
              </div>
              <div className="card-badges">
                <span className={`badge badge-priority-${data.objective.priority}`}>{data.objective.priority}</span>
                <span className="badge">{data.objective.status}</span>
              </div>
            </div>
          </article>

          <h2 className="section-title">Initiatives</h2>

          {data.initiatives.length === 0 && <p className="empty-state">No initiatives yet.</p>}

          {data.initiatives.map((initiative) => (
            <Link className="card-link" href={`/initiatives/${initiative.id}`} key={initiative.id}>
              <article className="card">
                <div className="card-top">
                  <div>
                    <p className="card-title">{initiative.title}</p>
                    {initiative.owner && <span className="owner-line">Owner: {initiative.owner}</span>}
                  </div>
                  <div className="card-badges">
                    <span className={`badge badge-priority-${initiative.priority}`}>{initiative.priority}</span>
                    <span className="badge">{initiative.status}</span>
                  </div>
                </div>
              </article>
            </Link>
          ))}

          <RelationshipsPanel entityType="objective" entityId={data.objective.id} />
        </>
      )}
    </main>
  );
}
