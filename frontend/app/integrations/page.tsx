"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  fetchCurrentUser,
  fetchIntegrations,
  generateIntegrationToken,
  type GeneratedIntegrationToken,
  type IntegrationStatus,
  type IntegrationType,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";

const LABELS: Record<string, string> = {
  circleback: "Circleback",
  email: "Email",
};

// Per-type instructions for the one-time "here's your webhook URL" card --
// looped over by type below rather than a second copy of the whole card's JSX.
const SETUP_INSTRUCTIONS: Record<string, string> = {
  circleback:
    "Paste the URL below into Circleback's automation settings (notes + action items are the most useful outputs to send; transcript is optional).",
  email:
    "Paste the URL below into your inbound email provider's webhook configuration (built against Postmark's inbound webhook shape -- see README) so forwarded mail lands here.",
};

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function IntegrationsPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [rows, setRows] = useState<IntegrationStatus[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [justGenerated, setJustGenerated] = useState<GeneratedIntegrationToken | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  function load() {
    fetchIntegrations()
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

  async function handleGenerate(type: string, alreadyConfigured: boolean) {
    if (alreadyConfigured) {
      const confirmed = window.confirm(
        `Rotating the ${LABELS[type] ?? type} token immediately invalidates the current one -- any webhook already ` +
          "configured with the old URL will start failing until you update it. Continue?",
      );
      if (!confirmed) return;
    }

    setBusyType(type);
    setActionError(null);
    setCopied(false);
    try {
      const result = await generateIntegrationToken(type as IntegrationType);
      setJustGenerated(result);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyType(null);
    }
  }

  async function handleCopy() {
    if (!justGenerated) return;
    try {
      await navigator.clipboard.writeText(justGenerated.webhookUrl);
      setCopied(true);
    } catch {
      setActionError("Couldn't copy automatically -- select and copy the URL manually.");
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
        <p>Sign in with your Exvade Google account to manage integrations.</p>
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
          <h1>Integrations</h1>
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
        <h1>Integrations</h1>
        <span className="muted">{user.email}</span>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {justGenerated && (
        <div className="card">
          <div className="card-title">
            {LABELS[justGenerated.type] ?? justGenerated.type} webhook {justGenerated.rotated ? "rotated" : "generated"}
          </div>
          <div className="token-warning">
            Copy this now -- the token won&rsquo;t be shown again.{" "}
            {SETUP_INSTRUCTIONS[justGenerated.type] ?? "Paste the URL below into the integration's webhook configuration."}
          </div>
          <div className="edit-field-label">Webhook URL</div>
          <div className="token-box">
            <span>{justGenerated.webhookUrl}</span>
          </div>
          <div className="card-actions">
            <button className="decision-btn save" onClick={handleCopy}>
              {copied ? "Copied" : "Copy URL"}
            </button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Last received</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = busyType === row.type;
                return (
                  <tr key={row.type}>
                    <td>{LABELS[row.type] ?? row.type}</td>
                    <td>
                      {row.configured ? (
                        <span className="chip chip-done">Configured</span>
                      ) : (
                        <span className="chip">Not configured</span>
                      )}
                    </td>
                    <td>{formatDateTime(row.lastReceivedAt)}</td>
                    <td>
                      <button
                        className="decision-btn save"
                        disabled={busy}
                        onClick={() => handleGenerate(row.type, row.configured)}
                      >
                        {row.configured ? "Rotate token" : "Generate token"}
                      </button>
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
