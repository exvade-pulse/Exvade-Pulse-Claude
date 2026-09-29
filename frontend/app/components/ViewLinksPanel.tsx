"use client";

import { useEffect, useState } from "react";
import { createViewLink, listViewLinks, revokeViewLink, type ViewLinkSummary } from "../../lib/api";

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="decision-btn"
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// Admin-only: password-protected, read-only links into the whole app, e.g.
// for a ChatGPT agent to review layout and accuracy.
export function ViewLinksPanel() {
  const [links, setLinks] = useState<ViewLinkSummary[] | null>(null);
  const [label, setLabel] = useState("ChatGPT agent");
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [includeRestricted, setIncludeRestricted] = useState(false);
  const [created, setCreated] = useState<{ url: string; password: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => listViewLinks().then((r) => setLinks(r.links)).catch((err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      setCreated(await createViewLink({ label: label.trim() || null, days, includeRestricted }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the link");
    } finally {
      setBusy(false);
    }
  }

  const agentPrompt = created
    ? `Please review Exvade Pulse, our internal operations tool, in read-only mode.\nOpen: ${created.url}\nEnter the password I'll give you on the password screen, then click Open.\nBrowse every page in the top menu, open collapsed sections and Details, and report back on (1) usability and layout: what's hard to scan, confusing, cluttered or broken, especially on the Executive page, and (2) accuracy: anything that looks wrong, stale, duplicated, contradictory or missing given what you know about Exvade. You can't change anything, so just report. Don't share the link or password anywhere.`
    : "";

  return (
    <section className="card">
      <h2 className="dash-panel-title">View-only links</h2>
      <p className="rc-meta">
        Lets someone who isn&rsquo;t a user, such as your ChatGPT agent, browse every page without being able to change anything. Users,
        Integrations and these links stay hidden. Each link needs its password, which is shown once. Share the two separately.
      </p>

      <div className="edit-form">
        <label className="edit-field">
          <span className="edit-field-label">Name (for your reference)</span>
          <input className="edit-input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="edit-field">
          <span className="edit-field-label">Expires after</span>
          <select className="edit-input" value={days} onChange={(e) => setDays(Number(e.target.value) as 1 | 7 | 30)}>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <label className="edit-field edit-field-checkbox">
          <input type="checkbox" checked={includeRestricted} onChange={(e) => setIncludeRestricted(e.target.checked)} />
          <span>Include Leadership and Restricted items (otherwise it sees what a regular member sees)</span>
        </label>
        <div className="card-actions">
          <button className="decision-btn save" disabled={busy} onClick={handleCreate}>
            {busy ? "Creating…" : "Create view-only link"}
          </button>
        </div>
        {error && <p className="error-inline">{error}</p>}
      </div>

      {created && (
        <div className="card view-link-created">
          <p>
            <strong>Save these now. The password won&rsquo;t be shown again.</strong> Expires {when(created.expiresAt)}.
          </p>
          <p className="edit-field-label">Link</p>
          <div className="view-link-secret">
            <code>{created.url}</code>
            <CopyButton text={created.url} />
          </div>
          <p className="edit-field-label">Password</p>
          <div className="view-link-secret">
            <code>{created.password}</code>
            <CopyButton text={created.password} />
          </div>
          <p className="edit-field-label">Suggested message for your ChatGPT agent (then send the password separately)</p>
          <div className="view-link-secret">
            <code>{agentPrompt}</code>
            <CopyButton text={agentPrompt} />
          </div>
        </div>
      )}

      {links && links.length > 0 && (
        <ul className="dash-list">
          {links.map((l) => (
            <li key={l.id}>
              <strong>{l.label ?? "Untitled link"}</strong>{" "}
              <span className="dash-detail">
                · {l.includeRestricted ? "everything" : "team items"} · created {when(l.createdAt)} by {l.createdByName} ·{" "}
                {l.active ? `expires ${when(l.expiresAt)}` : l.revokedAt ? "switched off" : "expired"}
                {l.lastUsedAt && ` · last opened ${when(l.lastUsedAt)}`}
              </span>{" "}
              {l.active && (
                <button
                  className="link-btn"
                  onClick={async () => {
                    if (!window.confirm("Switch this link off? Anyone using it is signed out immediately.")) return;
                    await revokeViewLink(l.id);
                    await load();
                  }}
                >
                  Switch off
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
