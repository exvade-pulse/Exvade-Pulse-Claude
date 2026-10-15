"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL, fetchCurrentUser, type SessionUser } from "../../lib/api";
import { Nav } from "../components/Nav";

// Admin-only download of every working record, for reconciling Pulse
// against an outside review or ledger (see backend reports/export.ts).

export default function ExportPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  if (user === "loading") return <main className="page" />;
  if (!user || user.role !== "admin" || user.readOnly) {
    return (
      <main className="page">
        <Nav user={user || null} />
        <p>Only an admin can export. {!user && <Link href="/">Sign in</Link>}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <Nav user={user} />
      <h1>Export</h1>
      <div className="card">
        <p>
          Everything Pulse holds about the work, with record ids: outcomes, initiatives, projects, tasks, milestones, risks, decisions,
          strategic questions, entities and relationships. It includes finished, cancelled and merged records, pending Review cards and
          source references (type, date and id only).
        </p>
        <p className="muted">
          Not included: email and transcript text, user accounts, sign-in and integration details. The file reflects Pulse at the moment you
          download it.
        </p>
        <div className="card-actions">
          <a className="decision-btn save" href={`${API_URL}/api/export`} download>
            Download everything (JSON)
          </a>
          <a className="decision-btn" href={`${API_URL}/api/export?format=tasks.csv`} download>
            Download tasks only (spreadsheet)
          </a>
        </div>
        <p className="muted">
          To check an outside task list against Pulse, send the JSON file along with that list: each task is matched only by its exact name,
          and anything ambiguous is listed for a person to resolve.
        </p>
      </div>
    </main>
  );
}
