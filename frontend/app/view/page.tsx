"use client";

import { useEffect, useState } from "react";
import { unlockViewLink } from "../../lib/api";

// The password screen for a view-only link (/view?t=...). The link alone
// isn't enough: the password is shared separately.
export default function ViewLinkPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("t"));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await unlockViewLink(token, password);
      window.location.href = "/executive";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="header">
        <h1>Exvade Pulse</h1>
      </div>
      {token === null ? (
        <p className="muted">Loading&hellip;</p>
      ) : !token ? (
        <p>This page needs a view-only link from an Exvade admin.</p>
      ) : (
        <form className="card edit-form view-unlock" onSubmit={handleSubmit}>
          <p>This is a private, read-only view of Exvade Pulse. Enter the password you were given.</p>
          <label className="edit-field">
            <span className="edit-field-label">Password</span>
            <input
              className="edit-input"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-label="Password"
            />
          </label>
          {error && <p className="error-inline">{error}</p>}
          <div className="card-actions">
            <button className="decision-btn save" type="submit" disabled={busy || !password.trim()}>
              {busy ? "Checking…" : "Open"}
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
