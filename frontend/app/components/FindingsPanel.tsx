"use client";

import { useEffect, useRef, useState } from "react";
import { fetchFindingsJob, startFindings, type FindingsJob } from "../../lib/api";

const KIND_LABEL: Record<string, string> = {
  update: "correction",
  create: "new item",
  merge: "merge",
  question: "strategic question",
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Paste a reviewer's findings (e.g. a ChatGPT audit). Data corrections become
// proposals in Review; software/design feedback comes back as a list to hand
// to the developer.
export function FindingsPanel({ onFinished }: { onFinished: () => void }) {
  const [text, setText] = useState("");
  const [job, setJob] = useState<FindingsJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  async function handleStart() {
    setError(null);
    try {
      const started = await startFindings(text);
      setJob(started);
      timer.current = setInterval(async () => {
        try {
          const latest = await fetchFindingsJob(started.id);
          setJob(latest);
          if (latest.status !== "running") {
            if (timer.current) clearInterval(timer.current);
            onFinished();
          }
        } catch (err) {
          if (timer.current) clearInterval(timer.current);
          setError(err instanceof Error ? err.message : "Lost track of the job");
        }
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start");
    }
  }

  const feedbackText = job
    ? [
        "Software/design feedback from a Pulse review (for Claude Code):",
        ...(["must", "should", "nice"] as const).flatMap((p) =>
          job.appFeedback
            .filter((f) => f.priority === p)
            .map((f) => `- [${p}] ${f.area}: ${f.issue}${f.suggestion ? ` Suggested: ${f.suggestion}` : ""}`),
        ),
      ].join("\n")
    : "";

  const running = job?.status === "running";

  return (
    <div className="card edit-form">
      {!job || running ? (
        <>
          <label className="edit-field">
            <span className="edit-field-label">
              Paste a review of Pulse (e.g. from your ChatGPT agent). Specific data corrections become proposals below for you to
              approve. Anything the reviewer says to verify is flagged and kept out of bulk approval. Design and software feedback
              comes back as a separate list.
            </span>
            <textarea
              className="edit-input"
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={running}
              placeholder="Paste the whole review, or just the sections with corrections."
            />
          </label>
          {error && <p className="error-inline">{error}</p>}
          <div className="card-actions">
            <button className="decision-btn save" disabled={running || !text.trim()} onClick={handleStart}>
              {running ? "Working…" : "Read findings"}
            </button>
            {running && job && (
              <span className="muted">
                Reading part {Math.min(job.partsDone + 1, job.partsTotal)} of {job.partsTotal}. This can take a few minutes; you can keep
                this page open.
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <p>
            <strong>
              {job.status === "failed"
                ? "Something went wrong."
                : job.proposals === 0
                  ? job.unresolved?.length
                    ? "Nothing could be applied. See why below."
                    : "No specific data corrections found."
                  : `${plural(job.proposals, "proposal")} added to Pending below`}
            </strong>
            {job.proposals > 0 && (
              <span className="muted">
                {" "}
                ({Object.entries(job.byKind)
                  .map(([k, n]) => plural(n, KIND_LABEL[k] ?? k))
                  .join(", ")}
                {job.needsVerification > 0 && `; ${job.needsVerification} flagged "verify first"`})
              </span>
            )}
          </p>
          {job.errors.map((e) => (
            <p key={e} className="error-inline">
              {e}
            </p>
          ))}
          {job.unresolved?.length > 0 && (
            <>
              <p className="edit-field-label">
                {plural(job.unresolved.length, "instruction")} Pulse couldn&apos;t act on. Fix the name or create the destination first,
                then paste these again:
              </p>
              <ul className="dash-list">
                {job.unresolved.map((u, i) => (
                  <li key={i}>
                    <strong>{u.text}</strong>
                    <span className="dash-detail">: {u.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {job.appFeedback.length > 0 && (
            <>
              <p className="edit-field-label">
                {plural(job.appFeedback.length, "software/design item")} (not data, so these need code changes). Copy and paste them to
                Claude Code:
              </p>
              <ul className="dash-list">
                {job.appFeedback.map((f) => (
                  <li key={`${f.area}|${f.issue}`}>
                    <span className="dash-kind">{f.priority}</span> <strong>{f.area}</strong>
                    <span className="dash-detail">: {f.issue}</span>
                  </li>
                ))}
              </ul>
              <div className="card-actions">
                <button
                  className="decision-btn"
                  onClick={async () => {
                    await navigator.clipboard.writeText(feedbackText);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy list for Claude Code"}
                </button>
              </div>
            </>
          )}
          <div className="card-actions">
            <button
              className="decision-btn"
              onClick={() => {
                setJob(null);
                setText("");
                setCopied(false);
              }}
            >
              Paste another
            </button>
          </div>
        </>
      )}
    </div>
  );
}
