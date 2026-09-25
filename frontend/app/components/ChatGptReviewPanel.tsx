"use client";

import Link from "next/link";
import { useState } from "react";
import { createReviewLink, fetchExecutiveReview } from "../../lib/api";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Copies text whose content is still being fetched. Safari only allows a
// clipboard write inside the click itself, so the fetch is handed to the
// clipboard as a pending promise (ClipboardItem) rather than awaited first.
async function copyWhenReady(textPromise: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const blob = textPromise.then((text) => new Blob([text], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // Some browsers reject a pending ClipboardItem but still allow a plain
      // write once the text is ready -- try that before giving up.
    }
  }
  await navigator.clipboard.writeText(await textPromise);
}

export function ChatGptReviewPanel({ isAdmin }: { isAdmin: boolean }) {
  const [busy, setBusy] = useState<"copy" | "link" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  async function handleCopy() {
    setBusy("copy");
    setError(null);
    setMessage(null);
    setFallbackText(null);
    const textPromise = fetchExecutiveReview().then((r) => r.text);
    try {
      await copyWhenReady(textPromise);
      setMessage("Copied. Paste it into your ChatGPT chat.");
    } catch {
      // Clipboard refused (permissions, older browser) -- show the text so it
      // can still be selected and copied by hand.
      try {
        setFallbackText(await textPromise);
        setMessage("Couldn't copy automatically -- select all the text below and copy it.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateLink() {
    setBusy("link");
    setError(null);
    setLinkCopied(false);
    try {
      setLink(await createReviewLink());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const linkMessage = link
    ? `Please open this link and review my latest Pulse executive review, using what you know about Exvade: ${link.url}`
    : "";

  async function handleCopyLinkMessage() {
    try {
      await navigator.clipboard.writeText(linkMessage);
      setLinkCopied(true);
    } catch {
      setError("Couldn't copy automatically -- select the text and copy it.");
    }
  }

  return (
    <div className="card chatgpt-panel">
      <div className="card-title">Review with ChatGPT</div>
      <p className="muted chatgpt-panel-help">
        Get a full snapshot of Pulse for your own ChatGPT to review. Paste its recommendations back through{" "}
        <Link href="/review">Add update</Link> on the Review page. They go to Review for your approval.
      </p>
      <div className="card-actions">
        <button className="decision-btn save" disabled={busy !== null} onClick={handleCopy}>
          {busy === "copy" ? "Preparing…" : "Copy for ChatGPT"}
        </button>
        {isAdmin && (
          <button className="decision-btn" disabled={busy !== null} onClick={handleCreateLink}>
            {busy === "link" ? "Creating…" : "Create private link (7 days)"}
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {message && <p className="chatgpt-panel-status">{message}</p>}
      {fallbackText && <textarea className="edit-input chatgpt-fallback" readOnly value={fallbackText} rows={12} />}

      {link && (
        <div className="chatgpt-link">
          <div className="edit-field-label">Send this to ChatGPT</div>
          <div className="token-box">
            <span>{linkMessage}</span>
          </div>
          <div className="card-actions">
            <button className="decision-btn save" onClick={handleCopyLinkMessage}>
              {linkCopied ? "Copied" : "Copy message"}
            </button>
          </div>
          <p className="muted chatgpt-panel-help">
            Works until {formatDate(link.expiresAt)} and always shows the latest data. Anyone with the link can read it, so
            only paste it into your own ChatGPT. If ChatGPT says it can&rsquo;t open it, use Copy for ChatGPT instead. To
            shut off every link at once, turn off ChatGPT on the <Link href="/integrations">Integrations</Link> page.
          </p>
        </div>
      )}
    </div>
  );
}
