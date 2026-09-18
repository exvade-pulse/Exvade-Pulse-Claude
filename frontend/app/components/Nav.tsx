"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SessionUser } from "../../lib/api";

export function Nav({ user }: { user?: SessionUser | null }) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <nav className="nav">
      <Link href="/">Dashboard</Link>
      <Link href="/company-map">Company Map</Link>
      <Link href="/company-entities">Entities</Link>
      <Link href="/unsorted">Unsorted</Link>
      <Link href="/review">Review</Link>
      <Link href="/decisions">Decisions</Link>
      <Link href="/reports/weekly">Weekly Report</Link>
      <Link href="/activity">Activity</Link>
      {user?.role === "admin" && <Link href="/users">Users</Link>}
      {user?.role === "admin" && <Link href="/integrations">Integrations</Link>}
      {user && (
        <form className="nav-search" onSubmit={handleSearchSubmit}>
          <input
            className="nav-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search objectives, tasks, decisions…"
            aria-label="Search"
          />
          <button className="nav-search-submit" type="submit" aria-label="Search">
            &#128269;
          </button>
        </form>
      )}
    </nav>
  );
}
