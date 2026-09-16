"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchSearch,
  type SearchResponse,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

const EMPTY_RESULTS: SearchResponse = { objectives: [], initiatives: [], projects: [], tasks: [], decisions: [] };

function resultCount(results: SearchResponse): number {
  return (
    results.objectives.length +
    results.initiatives.length +
    results.projects.length +
    results.tasks.length +
    results.decisions.length
  );
}

function parentChain(...entries: Array<{ title: string }>): string {
  return entries.map((e) => e.title).join(" › ");
}

function SearchPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";

  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResponse>(EMPTY_RESULTS);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  // Re-syncs the input when the Nav search box sends a new q here via
  // navigation (a fresh /search?q=... push), without fighting the user's own
  // typing on this page -- only on a real query-string change, not every
  // render.
  useEffect(() => {
    setQuery(searchParams.get("q") ?? "");
  }, [searchParams]);

  useEffect(() => {
    if (!user || user === "loading") return;

    const trimmed = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults(EMPTY_RESULTS);
      setSearchedFor(null);
      setLoadError(null);
      return;
    }

    debounceRef.current = setTimeout(() => {
      fetchSearch(trimmed)
        .then((res) => {
          setResults(res);
          setSearchedFor(trimmed);
          setLoadError(null);
        })
        .catch((err) => setLoadError(err.message));
      router.replace(`/search?q=${encodeURIComponent(trimmed)}`);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, user]);

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
        <p>Sign in with your Exvade Google account to search.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LENGTH;
  const hasSearched = searchedFor !== null;
  const count = resultCount(results);

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>Search</h1>
        <span className="muted">{user.email}</span>
      </div>

      <div className="card-actions" style={{ marginBottom: 16 }}>
        <input
          className="edit-input"
          style={{ width: "100%", maxWidth: 480 }}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search objectives, initiatives, projects, tasks, decisions…"
          autoFocus
        />
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {tooShort && <p className="muted">Keep typing — at least {MIN_QUERY_LENGTH} characters.</p>}

      {!tooShort && trimmed.length === 0 && <p className="empty-state">Search across the whole company map, plus decisions.</p>}

      {hasSearched && trimmed.length >= MIN_QUERY_LENGTH && count === 0 && !loadError && (
        <p className="empty-state">No matches for &ldquo;{searchedFor}&rdquo;.</p>
      )}

      {results.objectives.length > 0 && (
        <>
          <h2 className="section-title">Objectives</h2>
          <div className="card task-list">
            {results.objectives.map((o) => (
              <div className="task-row" key={o.id}>
                <div className="task-row-top">
                  <Link className="task-row-title" href={`/objectives/${o.id}`}>
                    {o.title}
                  </Link>
                  <span className="badge">{o.status}</span>
                </div>
                {o.owner && <p className="task-row-meta">Owner: {o.owner}</p>}
              </div>
            ))}
          </div>
        </>
      )}

      {results.initiatives.length > 0 && (
        <>
          <h2 className="section-title">Initiatives</h2>
          <div className="card task-list">
            {results.initiatives.map((i) => (
              <div className="task-row" key={i.id}>
                <div className="task-row-top">
                  <Link className="task-row-title" href={`/initiatives/${i.id}`}>
                    {i.title}
                  </Link>
                  <span className="badge">{i.status}</span>
                </div>
                <p className="task-row-meta">
                  {i.owner && <>Owner: {i.owner} &middot; </>}
                  {parentChain(i.objective)}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      {results.projects.length > 0 && (
        <>
          <h2 className="section-title">Projects</h2>
          <div className="card task-list">
            {results.projects.map((p) => (
              <div className="task-row" key={p.id}>
                <div className="task-row-top">
                  <Link className="task-row-title" href={`/projects/${p.id}`}>
                    {p.title}
                  </Link>
                  <span className="badge">{p.status}</span>
                </div>
                <p className="task-row-meta">
                  {p.owner && <>Owner: {p.owner} &middot; </>}
                  {parentChain(p.initiative)}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      {results.tasks.length > 0 && (
        <>
          <h2 className="section-title">Tasks</h2>
          <div className="card task-list">
            {results.tasks.map((t) => (
              <div className="task-row" key={t.id}>
                <div className="task-row-top">
                  <Link className="task-row-title" href={`/tasks/${t.id}`}>
                    {t.title}
                  </Link>
                  <span className="badge">{t.status.replace("_", " ")}</span>
                </div>
                <p className="task-row-meta">
                  {t.owner && <>Owner: {t.owner} &middot; </>}
                  {parentChain(t.objective, t.initiative, t.project)}
                </p>
                {t.latestUpdate && (
                  <p className="task-snippet">
                    <span className="task-snippet-label">Latest:</span> {t.latestUpdate}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {results.decisions.length > 0 && (
        <>
          <h2 className="section-title">Decisions</h2>
          <div className="card task-list">
            {results.decisions.map((d) => (
              <div className="task-row" key={d.id}>
                <div className="task-row-top">
                  <Link className="task-row-title" href="/decisions">
                    {d.title}
                  </Link>
                  <span className="badge">{d.status}</span>
                </div>
                <p className="task-row-meta">Decider: {d.decider}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <Nav />
          <p className="muted">Loading&hellip;</p>
        </main>
      }
    >
      <SearchPageContent />
    </Suspense>
  );
}
