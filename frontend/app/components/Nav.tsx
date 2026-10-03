"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SessionUser } from "../../lib/api";

// Four everyday pages up front; the rest grouped into Organize, Reports and
// Settings menus. Menus open on click (so they work on touch screens), close
// on Escape, an outside click or navigation, and the group holding the
// current page is highlighted.

interface Item {
  href: string;
  label: string;
  // Other paths that count as "this page" for highlighting.
  also?: string[];
  adminOnly?: boolean;
}

const TOP: Item[] = [
  { href: "/overview", label: "Overview" },
  { href: "/executive", label: "Operating Detail" },
  { href: "/review", label: "Review" },
  { href: "/decisions", label: "Decisions" },
];

const GROUPS: Array<{ label: string; items: Item[] }> = [
  {
    label: "Organize",
    items: [
      { href: "/company-map", label: "Company Map", also: ["/objectives", "/initiatives", "/projects", "/tasks"] },
      { href: "/unsorted", label: "Unsorted" },
      { href: "/questions", label: "Questions" },
      { href: "/company-entities", label: "Entities" },
    ],
  },
  {
    label: "Reports",
    items: [
      { href: "/reports/weekly", label: "Weekly Report" },
      { href: "/activity", label: "Activity" },
      { href: "/", label: "Dashboard" },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/context", label: "Context" },
      { href: "/users", label: "Users", adminOnly: true },
      { href: "/integrations", label: "Integrations", adminOnly: true },
      { href: "/guide", label: "Guide" },
    ],
  },
];

function isCurrent(item: Item, path: string) {
  const match = (p: string) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`));
  return match(item.href) || (item.also ?? []).some(match);
}

function Menu({ label, items, path, open, onToggle, alignRight }: { label: string; items: Item[]; path: string; open: boolean; onToggle: () => void; alignRight: boolean }) {
  const current = items.some((i) => isCurrent(i, path));
  const id = `nav-menu-${label.toLowerCase()}`;
  return (
    <div className="nav-group">
      <button type="button" className={`nav-group-btn${current ? " nav-current" : ""}`} aria-expanded={open} aria-controls={id} onClick={onToggle}>
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className={`nav-menu${alignRight ? " nav-menu-right" : ""}`} id={id}>
          {items.map((i) => (
            <li key={i.href}>
              <Link href={i.href} aria-current={isCurrent(i, path) ? "page" : undefined} className={isCurrent(i, path) ? "nav-current" : undefined}>
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Nav({ user }: { user?: SessionUser | null }) {
  const router = useRouter();
  const path = usePathname() ?? "/";
  // The Search page has its own search box; one is enough.
  const onSearchPage = path === "/search";
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  // Read-only review mode greys out and disables every action button
  // across the app (see .read-only-mode in globals.css); navigation stays.
  useEffect(() => {
    document.body.classList.toggle("read-only-mode", !!user?.readOnly);
  }, [user?.readOnly]);

  useEffect(() => setOpenMenu(null), [path]);

  useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenMenu(null);
        (navRef.current?.querySelector(`[aria-controls="nav-menu-${openMenu.toLowerCase()}"]`) as HTMLElement | null)?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".nav-group")) setOpenMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [openMenu]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  const canAdmin = user?.role === "admin" && !user.readOnly;
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly || canAdmin) }));

  return (
    <>
      {user?.readOnly && (
        <div className="readonly-banner" role="status">
          <strong>Read-Only Review Mode.</strong> Browse every page; creating, editing, approving and admin actions are disabled.
        </div>
      )}
      <nav className="nav" ref={navRef} aria-label="Main">
        {TOP.map((i) => (
          <Link key={i.href} href={i.href} aria-current={isCurrent(i, path) ? "page" : undefined} className={isCurrent(i, path) ? "nav-current" : undefined}>
            {i.label}
          </Link>
        ))}
        {groups.map((g, n) => (
          <Menu
            key={g.label}
            label={g.label}
            items={g.items}
            path={path}
            open={openMenu === g.label}
            alignRight={n === groups.length - 1}
            onToggle={() => setOpenMenu((m) => (m === g.label ? null : g.label))}
          />
        ))}
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
