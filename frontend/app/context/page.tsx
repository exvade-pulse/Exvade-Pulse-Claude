"use client";

import { useEffect, useState } from "react";
import {
  API_URL,
  draftCompanyContext,
  fetchCompanyContext,
  fetchCurrentUser,
  saveCompanyContext,
  type CompanyContextResponse,
  type SessionUser,
} from "../../lib/api";
import { Nav } from "../components/Nav";

const TEMPLATE = `About Exvade
-

Programs and products
-

People and roles (who decides what)
-

Partners, vendors, sites and investors
-

Current priorities
-

Terms and abbreviations
- `;

export default function CompanyContextPage() {
  const [user, setUser] = useState<SessionUser | null | "loading">("loading");
  const [saved, setSaved] = useState<CompanyContextResponse | null>(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);

  useEffect(() => {
    fetchCurrentUser().then(setUser);
  }, []);

  useEffect(() => {
    if (user && user !== "loading") {
      fetchCompanyContext()
        .then((r) => {
          setSaved(r);
          setText(r.content);
        })
        .catch((err) => setLoadError(err instanceof Error ? err.message : "Couldn't load"));
    }
  }, [user]);

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
        <p>Sign in with your Exvade Google account to see the company context.</p>
        <a className="signin-btn" href={`${API_URL}/auth/google`}>
          Sign in with Google
        </a>
      </main>
    );
  }

  const isAdmin = user.role === "admin";
  const dirty = saved !== null && text !== saved.content;
  const tooLong = saved !== null && text.length > saved.maxChars;

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const r = await saveCompanyContext(text);
      setSaved((s) => (s ? { ...s, content: r.content, updatedAt: r.updatedAt, updatedBy: "you" } : s));
      setText(r.content);
      setMessage("Saved. The AI uses this from the next email, meeting or check onward.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDraft() {
    if (dirty && !window.confirm("Replace your unsaved edits with an AI draft?")) return;
    setDrafting(true);
    setMessage(null);
    try {
      const { draft } = await draftCompanyContext();
      setText(draft);
      setMessage("Draft ready. Nothing is saved yet: correct anything marked (check), then click Save.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't draft");
    } finally {
      setDrafting(false);
    }
  }

  return (
    <main className="page">
      <Nav user={user} />
      <div className="header">
        <h1>Company context</h1>
      </div>
      <p className="muted">
        A short profile of Exvade that the AI reads before interpreting every email and meeting, and before every AI check. It helps
        the AI recognize names, programs, partners and abbreviations. It&rsquo;s background only: the AI won&rsquo;t treat it as
        news or propose changes because of it.
      </p>

      {loadError && <div className="error-banner">{loadError}</div>}
      {!saved && !loadError && <p className="muted">Loading&hellip;</p>}

      {saved && (
        <section className="card edit-form">
          {isAdmin ? (
            <>
              <textarea
                className="edit-input context-editor"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={TEMPLATE}
                rows={22}
                aria-label="Company context"
              />
              <p className={tooLong ? "error-inline" : "rc-meta"}>
                {text.length.toLocaleString()} / {saved.maxChars.toLocaleString()} characters
                {saved.updatedAt && (
                  <>
                    {" "}
                    · Last saved {new Date(saved.updatedAt).toLocaleString()}
                    {saved.updatedBy && ` by ${saved.updatedBy}`}
                  </>
                )}
              </p>
              <div className="card-actions">
                <button className="decision-btn save" disabled={saving || !dirty || tooLong} onClick={handleSave}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button className="decision-btn" disabled={drafting} onClick={handleDraft}>
                  {drafting ? "Drafting…" : saved.content ? "Improve with AI" : "Draft with AI"}
                </button>
                {!text && (
                  <button className="decision-btn" onClick={() => setText(TEMPLATE)}>
                    Start from template
                  </button>
                )}
                {dirty && (
                  <button className="decision-btn cancel" onClick={() => setText(saved.content)}>
                    Discard changes
                  </button>
                )}
              </div>
              {message && <p className="rc-meta">{message}</p>}
            </>
          ) : saved.content ? (
            <pre className="context-view">{saved.content}</pre>
          ) : (
            <p className="empty-inline">No company context written yet. An admin can add it here.</p>
          )}
        </section>
      )}
    </main>
  );
}
