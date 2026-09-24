"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  API_URL,
  disconnectGmail,
  fetchCurrentUser,
  fetchGmailActivity,
  fetchIntegrationActivity,
  fetchIntegrations,
  generateIntegrationToken,
  revokeIntegrationToken,
  triggerGmailSync,
  type GeneratedIntegrationToken,
  type GmailConnectionStatus,
  type IntegrationActivityItem,
  type IntegrationStatus,
  type IntegrationType,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";

const LABELS: Record<string, string> = {
  circleback: "Circleback",
  email: "Email",
  gmail: "Gmail",
  chatgpt: "ChatGPT assistant",
};

// Pasted into the Custom GPT's "Instructions" box. The confirm-before-sending
// rule here is belt-and-braces: the comment action is also marked
// consequential in the OpenAPI spec, so ChatGPT's own UI asks every time too.
const CHATGPT_INSTRUCTIONS = `You are my assistant for Exvade Pulse, the system that tracks Exvade Bioscience's objectives, projects, tasks and decisions.

- Use getCompanyOverview to answer questions about status, what's stuck, what's overdue or what changed recently. Use getTask for detail on one task, listOpenDecisions for decisions, and listPendingReview for what's waiting for my approval.
- Only state facts that come from Pulse. If Pulse doesn't say, tell me you don't know rather than guessing.
- Before sending anything with sendCommentToPulse, show me the exact comment you plan to send and wait for me to say yes. Name the specific task, project or decision the comment is about.
- Comments become suggestions I approve or reject on Pulse's Review page -- they never change anything directly. Say so when you send one.`;

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
  return (
    <Suspense fallback={null}>
      <IntegrationsPageInner />
    </Suspense>
  );
}

// useSearchParams() (needed for the ?gmail_error= redirect from
// /auth/gmail/callback) requires a Suspense boundary in the App Router --
// split into a thin wrapper + this inner component rather than restructuring
// the whole page around it.
function IntegrationsPageInner() {
  const searchParams = useSearchParams();
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [rows, setRows] = useState<IntegrationStatus[]>([]);
  const [gmail, setGmail] = useState<GmailConnectionStatus | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [justGenerated, setJustGenerated] = useState<GeneratedIntegrationToken | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [gmailError, setGmailError] = useState<string | null>(searchParams.get("gmail_error"));
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailSyncResult, setGmailSyncResult] = useState<string | null>(null);

  const [openActivityType, setOpenActivityType] = useState<string | null>(null);
  const [activity, setActivity] = useState<IntegrationActivityItem[] | "loading">("loading");
  const [activityError, setActivityError] = useState<string | null>(null);

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
        setRows(result.integrations);
        setGmail(result.gmail);
      })
      .catch((err) => setLoadError(err.message));
  }

  useEffect(() => {
    if (user && user !== "loading") load();
  }, [user]);

  async function handleGmailSync() {
    setGmailBusy(true);
    setGmailError(null);
    setGmailSyncResult(null);
    try {
      const result = await triggerGmailSync();
      setGmailSyncResult(
        `Checked ${result.messagesFound} message${result.messagesFound === 1 ? "" : "s"}, ` +
          `created ${result.suggestionsCreated} suggestion${result.suggestionsCreated === 1 ? "" : "s"}` +
          (result.errors > 0 ? `, ${result.errors} error${result.errors === 1 ? "" : "s"}` : ""),
      );
      load();
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : "Gmail sync failed");
    } finally {
      setGmailBusy(false);
    }
  }

  async function handleGmailDisconnect() {
    const confirmed = window.confirm(
      "Disconnect Gmail? New mail will stop being imported until you connect it again.",
    );
    if (!confirmed) return;
    setGmailBusy(true);
    setGmailError(null);
    try {
      await disconnectGmail();
      load();
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : "Failed to disconnect Gmail");
    } finally {
      setGmailBusy(false);
    }
  }

  async function handleGenerate(type: string, alreadyConfigured: boolean) {
    if (alreadyConfigured) {
      const confirmed = window.confirm(
        type === "chatgpt"
          ? "Rotating the ChatGPT key immediately stops the current one working -- you'll need to paste the new key " +
              "into your Custom GPT's Action settings. Continue?"
          : `Rotating the ${LABELS[type] ?? type} token immediately invalidates the current one -- any webhook already ` +
              "configured with the old URL will start failing until you update it. Continue?",
      );
      if (!confirmed) return;
    }

    setBusyType(type);
    setActionError(null);
    setCopied(null);
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

  function toggleActivity(type: string) {
    if (openActivityType === type) {
      setOpenActivityType(null);
      return;
    }
    setOpenActivityType(type);
    setActivity("loading");
    setActivityError(null);
    const fetchActivity = type === "gmail" ? fetchGmailActivity() : fetchIntegrationActivity(type as IntegrationType);
    fetchActivity.then(setActivity).catch((err) => setActivityError(err.message));
  }

  async function handleRevoke(type: string) {
    const confirmed = window.confirm(
      `Turn off ${LABELS[type] ?? type}? Its current key stops working immediately. You can generate a new one later.`,
    );
    if (!confirmed) return;
    setBusyType(type);
    setActionError(null);
    try {
      await revokeIntegrationToken(type as IntegrationType);
      if (justGenerated?.type === type) setJustGenerated(null);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyType(null);
    }
  }

  async function handleCopy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setActionError("Couldn't copy automatically -- select and copy it manually.");
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
      {gmailError && <div className="error-banner">{gmailError}</div>}
      {gmailSyncResult && <p className="card activity-summary">{gmailSyncResult}</p>}

      {justGenerated && justGenerated.type === "chatgpt" && (
        <div className="card">
          <div className="card-title">ChatGPT key {justGenerated.rotated ? "rotated" : "generated"}</div>
          <div className="token-warning">
            Copy the key now -- it won&rsquo;t be shown again. If you lose it, just rotate to get a new one.
          </div>

          <div className="edit-field-label">1. Your key</div>
          <div className="token-box">
            <span>{justGenerated.token}</span>
          </div>
          <div className="card-actions">
            <button className="decision-btn save" onClick={() => handleCopy(justGenerated.token, "key")}>
              {copied === "key" ? "Copied" : "Copy key"}
            </button>
          </div>

          <div className="edit-field-label">2. Connection address</div>
          <div className="token-box">
            <span>{justGenerated.schemaUrl}</span>
          </div>
          <div className="card-actions">
            <button className="decision-btn" onClick={() => handleCopy(justGenerated.schemaUrl ?? "", "schema")}>
              {copied === "schema" ? "Copied" : "Copy address"}
            </button>
          </div>

          <div className="edit-field-label">3. Set it up in ChatGPT</div>
          <ol className="setup-steps">
            <li>In ChatGPT, open <strong>GPTs</strong> &rarr; <strong>Create</strong>, then the <strong>Configure</strong> tab.</li>
            <li>Name it (e.g. &ldquo;Pulse Assistant&rdquo;) and paste the instructions below into <strong>Instructions</strong>.</li>
            <li>
              Under <strong>Actions</strong>, click <strong>Create new action</strong> &rarr; <strong>Import from URL</strong>,
              paste the connection address, and import.
            </li>
            <li>
              Set <strong>Authentication</strong> to <strong>API Key</strong>, auth type <strong>Bearer</strong>, and paste your
              key.
            </li>
            <li>Save the GPT with sharing set to <strong>Only me</strong>.</li>
            <li>
              Ask it something like &ldquo;What&rsquo;s stuck right now?&rdquo; You can let it read Pulse without asking each
              time, but it will always ask before sending a comment.
            </li>
          </ol>

          <div className="edit-field-label">Instructions to paste into the GPT</div>
          <pre className="token-box setup-instructions">{CHATGPT_INSTRUCTIONS}</pre>
          <div className="card-actions">
            <button className="decision-btn" onClick={() => handleCopy(CHATGPT_INSTRUCTIONS, "instructions")}>
              {copied === "instructions" ? "Copied" : "Copy instructions"}
            </button>
          </div>
        </div>
      )}

      {justGenerated && justGenerated.webhookUrl && (
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
            <button className="decision-btn save" onClick={() => handleCopy(justGenerated.webhookUrl ?? "", "url")}>
              {copied === "url" ? "Copied" : "Copy URL"}
            </button>
          </div>
        </div>
      )}

      {(rows.length > 0 || gmail) && (
        <div className="card users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Last activity</th>
                <th>Suggestions</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {gmail && (
                <tr>
                  <td>Gmail</td>
                  <td>
                    {gmail.connected ? (
                      <span className="chip chip-done" title={gmail.emailAddress ?? undefined}>
                        Connected{gmail.emailAddress ? ` (${gmail.emailAddress})` : ""}
                      </span>
                    ) : (
                      <span className="chip">Not connected</span>
                    )}
                    {gmail.lastSyncError && (
                      <div className="muted" style={{ marginTop: 4 }}>
                        Last sync error: {gmail.lastSyncError}
                      </div>
                    )}
                  </td>
                  <td>{formatDateTime(gmail.lastSyncedAt)}</td>
                  <td>{gmail.totalSuggestions}</td>
                  <td>
                    <button className="decision-btn" onClick={() => toggleActivity("gmail")}>
                      {openActivityType === "gmail" ? "Hide activity" : "View activity"}
                    </button>
                  </td>
                  <td>
                    {gmail.connected ? (
                      <div className="card-actions">
                        <button className="decision-btn" disabled={gmailBusy} onClick={handleGmailSync}>
                          Sync now
                        </button>
                        <button className="decision-btn reject" disabled={gmailBusy} onClick={handleGmailDisconnect}>
                          Disconnect
                        </button>
                      </div>
                    ) : (
                      <a className="decision-btn save" href={`${API_URL}/auth/gmail/connect`}>
                        Connect Gmail
                      </a>
                    )}
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const busy = busyType === row.type;
                const activityOpen = openActivityType === row.type;
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
                    <td>{row.totalSuggestions}</td>
                    <td>
                      <button className="decision-btn" onClick={() => toggleActivity(row.type)}>
                        {activityOpen ? "Hide activity" : "View activity"}
                      </button>
                    </td>
                    <td>
                      <div className="card-actions">
                        <button
                          className="decision-btn save"
                          disabled={busy}
                          onClick={() => handleGenerate(row.type, row.configured)}
                        >
                          {row.configured ? "Rotate" : "Generate"} {row.type === "chatgpt" ? "key" : "token"}
                        </button>
                        {row.configured && (
                          <button className="decision-btn reject" disabled={busy} onClick={() => handleRevoke(row.type)}>
                            Turn off
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openActivityType && (
        <>
          <h2 className="section-title">{LABELS[openActivityType] ?? openActivityType} activity</h2>
          {activityError && <div className="error-banner">{activityError}</div>}
          {activity === "loading" && <p className="muted">Loading&hellip;</p>}
          {activity !== "loading" && activity.length === 0 && !activityError && (
            <p className="empty-state">No activity yet.</p>
          )}
          {activity !== "loading" && activity.length > 0 && (
            <div className="card task-list">
              {activity.map((item) => (
                <div className="task-row" key={item.id}>
                  <div className="task-row-top">
                    <span className="task-row-title">{item.externalId}</span>
                    <span className="chip" title="Suggestions generated from this item">
                      {item.suggestionCount} suggestion{item.suggestionCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className="muted task-row-time">Received {formatDateTime(item.receivedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
