"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchUnsorted,
  triggerUnsortedRetriage,
  type RetriageResult,
  type SessionUser,
  type UnsortedResponse,
  type UnsortedTask,
} from "../../lib/api";
import { Nav } from "../components/Nav";

function UnsortedTaskRow({ task }: { task: UnsortedTask }) {
  return (
    <div className="tree-task-row">
      <Link className="tree-title-link" href={`/tasks/${task.id}`}>
        {task.title}
      </Link>
      {task.owner && <span className="owner-line">Owner: {task.owner}</span>}
      {task.latestUpdate && <span className="owner-line">{task.latestUpdate}</span>}
      {task.pendingSuggestion && (
        <Link className="chip chip-attention" href="/review" title="A suggested move is waiting in Review">
          suggestion ready ({Math.round(task.pendingSuggestion.confidence * 100)}%)
        </Link>
      )}
      <span className="badge">{task.status.replace("_", " ")}</span>
    </div>
  );
}

export default function UnsortedPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [data, setData] = useState<UnsortedResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retriaging, setRetriaging] = useState(false);
  const [retriageResult, setRetriageResult] = useState<RetriageResult | null>(null);
  const [retriageError, setRetriageError] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchUnsorted()
        .then(setData)
        .catch((err) => setLoadError(err.message));
    }
  }, [user]);

  async function handleRetriage() {
    setRetriaging(true);
    setRetriageError(null);
    setRetriageResult(null);
    try {
      const result = await triggerUnsortedRetriage();
      setRetriageResult(result);
      const refreshed = await fetchUnsorted();
      setData(refreshed);
    } catch (err) {
      setRetriageError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setRetriaging(false);
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
        <p>Sign in with your Exvade Google account to see Unsorted tasks.</p>
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
        <h1>Unsorted / Needs Triage</h1>
        <span className="muted">{user.email}</span>
      </div>

      <p className="card-summary">
        Tasks that were tracked before a real project existed for them. Checking asks Claude whether each one now has
        a real home among the company's actual projects -- any match shows up as a normal suggestion in Review, with
        its own confidence, for you to approve or reject.
      </p>

      <div className="card-actions" style={{ marginBottom: 16 }}>
        <button className="decision-btn" onClick={handleRetriage} disabled={retriaging || !data?.project}>
          {retriaging ? "Checking…" : "Suggest where these belong"}
        </button>
      </div>

      {retriageResult && (
        <p className="card activity-summary">
          Checked {retriageResult.checked} task{retriageResult.checked === 1 ? "" : "s"} -- proposed{" "}
          {retriageResult.suggested} move{retriageResult.suggested === 1 ? "" : "s"}.
          {retriageResult.suggested > 0 && (
            <>
              {" "}
              <Link href="/review">Review them</Link>.
            </>
          )}
        </p>
      )}
      {retriageError && <div className="error-banner">{retriageError}</div>}
      {loadError && <div className="error-banner">{loadError}</div>}

      {data && !data.project && !loadError && <p className="empty-state">No Unsorted project exists yet.</p>}
      {data && data.project && data.tasks.length === 0 && !loadError && (
        <p className="empty-state">Nothing sitting in Unsorted right now.</p>
      )}

      {data && data.tasks.length > 0 && (
        <div className="tree">
          <div className="tree-children" style={{ marginLeft: 0 }}>
            {data.tasks.map((task) => (
              <UnsortedTaskRow task={task} key={task.id} />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
