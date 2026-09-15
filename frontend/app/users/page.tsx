"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  authorizeUser,
  changeUserRole,
  fetchAuthorizedUsers,
  fetchCurrentUser,
  revokeUser,
  type AuthorizedUser,
  type SessionUser,
  type UserRole,
} from "../../lib/api";
import { Nav } from "../components/Nav";

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function UsersPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [rows, setRows] = useState<AuthorizedUser[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("member");
  const [authorizing, setAuthorizing] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  function load() {
    fetchAuthorizedUsers()
      .then((result) => {
        if (result === "forbidden") {
          setForbidden(true);
          return;
        }
        setRows(result);
      })
      .catch((err) => setLoadError(err.message));
  }

  useEffect(() => {
    if (user && user !== "loading") load();
  }, [user]);

  async function handleAuthorize(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail.trim()) {
      setActionError("Email is required.");
      return;
    }
    setAuthorizing(true);
    setActionError(null);
    try {
      await authorizeUser(newEmail.trim().toLowerCase(), newRole);
      setNewEmail("");
      setNewRole("member");
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setAuthorizing(false);
    }
  }

  async function handleRoleChange(email: string, role: UserRole) {
    setBusyEmail(email);
    setActionError(null);
    try {
      await changeUserRole(email, role);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyEmail(null);
    }
  }

  async function handleRevoke(email: string) {
    setBusyEmail(email);
    setActionError(null);
    try {
      await revokeUser(email);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyEmail(null);
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
        <p>Sign in with your Exvade Google account to manage users.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  if (forbidden) {
    return (
      <main className="page">
        <Nav user={user} />
        <div className="header">
          <h1>Users</h1>
          <span className="muted">{user.email}</span>
        </div>
        <p className="empty-state">You don&rsquo;t have access to this page. Ask an admin if you need it.</p>
      </main>
    );
  }

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>Users</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      <form className="card edit-form" onSubmit={handleAuthorize}>
        <label className="edit-field">
          <span className="edit-field-label">Authorize someone</span>
          <input
            className="edit-input"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="name@exvadebio.com"
          />
        </label>
        <label className="edit-field">
          <span className="edit-field-label">Role</span>
          <select
            className="edit-input"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as UserRole)}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <div className="card-actions">
          <button className="decision-btn save" type="submit" disabled={authorizing}>
            Authorize
          </button>
        </div>
      </form>

      {rows.length === 0 && !loadError && <p className="empty-state">No authorized users.</p>}

      {rows.length > 0 && (
        <div className="card users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Status</th>
                <th>Role</th>
                <th>Authorized</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isSelf = row.email === user.email;
                const busy = busyEmail === row.email;
                return (
                  <tr key={row.email}>
                    <td>{row.email}</td>
                    <td>{row.name ?? <span className="muted">&mdash;</span>}</td>
                    <td>
                      {row.hasSignedIn ? (
                        <span className="chip chip-done">Signed in</span>
                      ) : (
                        <span className="chip">Pending</span>
                      )}
                    </td>
                    <td>
                      <select
                        className="edit-input"
                        value={row.role}
                        disabled={isSelf || busy}
                        onChange={(e) => handleRoleChange(row.email, e.target.value as UserRole)}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td>{formatDate(row.createdAt)}</td>
                    <td>
                      {!isSelf && (
                        <button
                          className="decision-btn reject"
                          disabled={busy}
                          onClick={() => handleRevoke(row.email)}
                        >
                          Revoke
                        </button>
                      )}
                      {isSelf && <span className="muted">(you)</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
