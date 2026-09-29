"use client";

import { useState } from "react";
import { setTaskStatus, type TaskStatus } from "../../lib/api";

type Choice = "completed" | "cancelled";

const CONFIRM_LABEL: Record<Choice, string> = {
  completed: "Mark done",
  cancelled: "Mark not relevant",
};

// Close out a task directly: "Mark done", or "Not relevant anymore" (it's
// cancelled -- removed from every list and report, history kept). A done
// or cancelled task can be reopened. Asks for an optional one-line note
// first, so there's a record of why.
export function TaskDisposition({
  taskId,
  status,
  onChanged,
}: {
  taskId: string;
  status: TaskStatus;
  onChanged: (next: { status: TaskStatus; latestUpdate: string | null }) => void;
}) {
  const [choosing, setChoosing] = useState<Choice | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: Choice | "active", withNote?: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await setTaskStatus(taskId, next, withNote);
      setChoosing(null);
      setNote("");
      onChanged(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (status === "superseded") return null;

  if (status === "completed" || status === "cancelled") {
    return (
      <div className="card-actions">
        <button className="decision-btn" disabled={busy} onClick={() => apply("active")}>
          Reopen
        </button>
        {error && <span className="due-overdue">{error}</span>}
      </div>
    );
  }

  if (choosing) {
    return (
      <div className="edit-form">
        <label className="edit-field">
          <span className="edit-field-label">
            {choosing === "cancelled" ? "Why isn't it relevant anymore? (optional)" : "Anything to note? (optional)"}
          </span>
          <input
            className="edit-input"
            value={note}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            placeholder={choosing === "cancelled" ? "e.g. Old lab funding question, no longer applies" : "e.g. Shipped Monday"}
          />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <div className="card-actions">
          <button className="decision-btn save" disabled={busy} onClick={() => apply(choosing, note.trim() || undefined)}>
            {CONFIRM_LABEL[choosing]}
          </button>
          <button className="decision-btn cancel" disabled={busy} onClick={() => setChoosing(null)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card-actions">
      <button className="decision-btn" onClick={() => setChoosing("completed")}>
        Mark done
      </button>
      <button className="decision-btn" onClick={() => setChoosing("cancelled")}>
        Not relevant anymore
      </button>
    </div>
  );
}
