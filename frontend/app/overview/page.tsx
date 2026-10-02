"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchCurrentUser, type SessionUser } from "../../lib/api";
import { fetchOverview, type ExecutiveOverview } from "../../lib/overview";
import { Nav } from "../components/Nav";
import { AttentionList, MaterialChanges, NarrativePanel, OutcomeCard, TopRisks } from "../components/overview/Parts";
import { StrategicRoadmap } from "../components/overview/Roadmap";

// The Executive Overview: for someone who checks in every few weeks. Where
// the company is, what needs leadership, how each outcome is doing and
// why, the roadmap, what changed, and the top risks. The day-to-day detail
// is on Operating Detail (/executive).

export default function OverviewPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [overview, setOverview] = useState<ExecutiveOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchOverview()
      .then(setOverview)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the overview"));
  }, []);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") load();
  }, [user, load]);

  if (user === "loading") return <main className="page" />;
  if (!user) {
    return (
      <main className="page">
        <Nav user={null} />
        <p>
          Please <Link href="/">sign in</Link> to see the overview.
        </p>
      </main>
    );
  }

  return (
    <main className="page xo-page">
      <Nav user={user} />
      <header className="xo-header">
        <div>
          <h1 className="xo-h1">Executive overview</h1>
          <p className="xo-sub">
            {overview ? `As of ${new Date(overview.asOf).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}` : "Loading…"}
          </p>
        </div>
        <Link className="xo-more" href="/executive">
          Operating detail →
        </Link>
      </header>

      {error && (
        <div className="xo-card" role="alert">
          <p className="error-inline">The overview couldn&apos;t load: {error}. Nothing below is current.</p>
          <button className="decision-btn" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {!overview && !error && <p className="muted">Loading the overview…</p>}

      {overview && (
        <>
          <div className="xo-row">
            <NarrativePanel overview={overview} canPublish={user.role === "admin" && !user.readOnly} onPublished={load} />
            <AttentionList items={overview.attention} total={overview.attentionTotal} />
          </div>

          <section aria-labelledby="xo-outcomes">
            <h2 className="xo-label" id="xo-outcomes">
              Outcomes ({overview.outcomes.length})
            </h2>
            {overview.outcomes.length === 0 ? (
              <p className="xo-empty xo-card">No outcomes yet. Outcomes are the objectives on the Company Map (Unsorted isn&apos;t one).</p>
            ) : (
              <div className="xo-grid">
                {overview.outcomes.map((o) => (
                  <OutcomeCard key={o.id} outcome={o} />
                ))}
              </div>
            )}
          </section>

          <StrategicRoadmap outcomes={overview.outcomes} scheduled={overview.roadmap.scheduled} unscheduled={overview.roadmap.unscheduled} asOf={overview.asOf} />

          <div className="xo-row xo-row-even">
            <MaterialChanges overview={overview} />
            <TopRisks overview={overview} />
          </div>
        </>
      )}
    </main>
  );
}
