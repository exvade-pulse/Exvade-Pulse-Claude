"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  createCompanyEntity,
  fetchCompanyEntities,
  fetchCurrentUser,
  type CompanyEntity,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";

const EMPTY_FORM = { name: "", kind: "", notes: "" };

export default function CompanyEntitiesPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [entities, setEntities] = useState<CompanyEntity[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchCompanyEntities()
        .then(setEntities)
        .catch((err) => setLoadError(err.message));
    }
  }, [user]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setActionError("Name is required.");
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      const created = await createCompanyEntity({
        name: form.name,
        kind: form.kind || null,
        notes: form.notes || null,
      });
      setEntities((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setCreating(false);
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
        <p>Sign in with your Exvade Google account to see company entities.</p>
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
        <h1>Company entities</h1>
        <span className="muted">{user.email}</span>
      </div>
      <p className="muted" style={{ marginBottom: 16 }}>
        External orgs and people worth tracking for their relationships to real work -- regulators, funders, vendors,
        collaborators. Not part of the Objective/Initiative/Project/Task hierarchy itself.
      </p>

      {loadError && <div className="error-banner">{loadError}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="card-actions" style={{ marginBottom: 16 }}>
        <button className="decision-btn" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add entity"}
        </button>
      </div>

      {showForm && (
        <form className="card edit-form" onSubmit={handleCreate}>
          <label className="edit-field">
            <span className="edit-field-label">Name</span>
            <input
              className="edit-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Duke University, FDA, NIH"
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Kind (optional)</span>
            <input
              className="edit-input"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              placeholder="e.g. regulator, funder, vendor, clinical trial site"
            />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">Notes (optional)</span>
            <input
              className="edit-input"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </label>
          <div className="card-actions">
            <button className="decision-btn save" type="submit" disabled={creating}>
              Create
            </button>
          </div>
        </form>
      )}

      {entities.length === 0 && !loadError && <p className="empty-state">No company entities yet.</p>}

      {entities.map((entity) => (
        <article className="card" key={entity.id}>
          <div className="card-top">
            <div>
              <p className="card-title">{entity.name}</p>
              {entity.notes && <span className="muted">{entity.notes}</span>}
            </div>
            {entity.kind && <span className="badge">{entity.kind}</span>}
          </div>
        </article>
      ))}
    </main>
  );
}
