"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { SessionUser } from "../../lib/api";

export function Nav({ user }: { user?: SessionUser | null }) {
  const router = useRouter();
  // The Search page has its own search box; one is enough.
  const onSearchPage = usePathname() === "/search";
  const [query, setQuery] = useState("");

  // Read-only review mode greys out and disables every action button
  // across the app (see .read-only-mode in globals.css); navigation stays.
  useEffect(() => {
    document.body.classList.toggle("read-only-mode", !!user?.readOnly);
  }, [user?.readOnly]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <>
    {user?.readOnly && (
      <div className="readonly-banner" role="status">
        <strong>Read-Only Review Mode.</strong> Browse every page; creating, editing, approving and admin actions are disabled.
      </div>
    )}
    <nav className="nav">
      <Link href="/">Dashboard</Link>
      <Link href="/executive">Executive</Link>
      <Link href="/questions">Questions</Link>
      <Link href="/company-map">Company Map</Link>
      <Link href="/company-entities">Entities</Link>
      <Link href="/unsorted">Unsorted</Link>
      <Link href="/review">Review</Link>
      <Link href="/decisions">Decisions</Link>
      <Link href="/reports/weekly">Weekly Report</Link>
      <Link href="/activity">Activity</Link>
      {user?.role === "admin" && !user.readOnly && <Link href="/users">Users</Link>}
      {user?.role === "admin" && !user.readOnly && <Link href="/integrations">Integrations</Link>}
      <Link href="/context">Context</Link>
      <Link href="/guide">Guide</Link>
      {user && !onSearchPage && (
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
    </>
  );
}
