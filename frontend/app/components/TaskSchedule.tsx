"use client";

import { useState } from "react";
import { setTaskSchedule, type DateType, type TaskSchedule as Schedule } from "../../lib/api";
import { formatDueDate } from "../../lib/dates";

const TYPE_LABEL: Record<DateType, string> = {
  confirmed: "Confirmed (a real deadline or fixed meeting)",
  planned: "Planned (a scheduled or intended checkpoint)",
  estimated: "Estimate (someone's best guess)",
};

// The task's date (what, when, how firm) and what it's waiting for. Setting
// these is a direct human edit, like marking the task done.
export function TaskScheduleCard({ taskId, schedule, onSaved }: { taskId: string; schedule: Schedule; onSaved: (next: Schedule) => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    dueDate: schedule.dueDate?.slice(0, 10) ?? "",
    dueDateType: schedule.dueDateType ?? "planned",
    dueLabel: schedule.dueLabel ?? "",
    waitingFor: schedule.waitingFor ?? "",
    followUpOn: schedule.followUpOn?.slice(0, 10) ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const next = await setTaskSchedule(taskId, {
        dueDate: form.dueDate || null,
        dueDateType: form.dueDate ? (form.dueDateType as DateType) : null,
        dueLabel: form.dueDate ? form.dueLabel || null : null,
        waitingFor: form.waitingFor || null,
        followUpOn: form.followUpOn || null,
      });
      onSaved(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    const empty = !schedule.dueDate && !schedule.waitingFor;
    return (
      <div className="decision-sections">
        <div>
          <p className="decision-section-label">Date &amp; waiting on</p>
          {empty ? (
            <p className="decision-section-body muted">No date or dependency recorded.</p>
          ) : (
            <>
              {schedule.dueDate && (
                <p className="decision-section-body">
                  <strong>{formatDueDate(schedule.dueDate)}</strong>
                  {schedule.dueDateType && <span className="muted"> ({schedule.dueDateType === "estimated" ? "estimate" : schedule.dueDateType})</span>}
                  {schedule.dueLabel && ` · ${schedule.dueLabel}`}
                </p>
              )}
              {schedule.waitingFor && (
                <p className="decision-section-body">
                  Waiting for: {schedule.waitingFor}
                  {schedule.followUpOn && <span className="muted"> · follow up {formatDueDate(schedule.followUpOn)}</span>}
                </p>
              )}
            </>
          )}
          <div className="card-actions">
            <button className="decision-btn" onClick={() => setEditing(true)}>
              {empty ? "Add date or dependency" : "Edit"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="edit-form">
      <label className="edit-field">
        <span className="edit-field-label">Date</span>
        <input className="edit-input" type="date" value={form.dueDate} onChange={set("dueDate")} />
      </label>
      {form.dueDate && (
        <>
          <label className="edit-field">
            <span className="edit-field-label">What happens on that date</span>
            <input className="edit-input" value={form.dueLabel} onChange={set("dueLabel")} placeholder="e.g. Aged domes available" />
          </label>
          <label className="edit-field">
            <span className="edit-field-label">How firm is it?</span>
            <select className="edit-input" value={form.dueDateType} onChange={set("dueDateType")}>
              {(Object.keys(TYPE_LABEL) as DateType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="edit-field">
        <span className="edit-field-label">Waiting for (who: what)</span>
        <input className="edit-input" value={form.waitingFor} onChange={set("waitingFor")} placeholder="e.g. Duke pathology: scanned slides" />
      </label>
      {form.waitingFor && (
        <label className="edit-field">
          <span className="edit-field-label">Follow up on</span>
          <input className="edit-input" type="date" value={form.followUpOn} onChange={set("followUpOn")} />
        </label>
      )}
      {error && <p className="error-inline">{error}</p>}
      <div className="card-actions">
        <button className="decision-btn save" disabled={saving} onClick={handleSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="decision-btn cancel" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
