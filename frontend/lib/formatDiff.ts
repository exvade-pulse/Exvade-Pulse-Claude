import { formatDueDate } from "./dates";

// Foreign keys (objectiveId, projectId, ...) are implementation detail, not
// something a reader needs to see -- "where it belongs" is already conveyed
// elsewhere (the "Proposes new X" / "Updates existing X" line on a suggestion
// card, or a task's own breadcrumb). newParent (a destination named in Edit)
// shows on the card's "Moving to" line instead.
export const HIDDEN_DIFF_KEYS = new Set(["objectiveId", "initiativeId", "projectId", "newParent"]);


// Plain-language names instead of raw field names.
const FIELD_LABEL: Record<string, string> = {
  latestUpdate: "Latest update",
  nextAction: "Next action",
  description: "Description",
  status: "Status",
  owner: "Owner",
  title: "Title",
  priority: "Priority",
  whyItMatters: "Why it matters",
  relevantContext: "Context",
  suggestedNextStep: "Suggested next step",
  decider: "Decider",
  stakeholders: "Stakeholders",
  dueDate: "Due date",
  relatedTaskId: "Related task",
  supersededById: "Merge into",
};

const label = (key: string) => FIELD_LABEL[key] ?? key;

// Shared by the review page's pending/history suggestion cards and the task
// detail page's approved-suggestion history, so "what changed" reads the same
// way everywhere a proposedDiff is shown.
export function formatDiff(diff: Record<string, unknown>): string {
  return Object.entries(diff)
    .filter(([key]) => !HIDDEN_DIFF_KEYS.has(key))
    // Array.prototype.toString() (what String(value) falls back to) joins with
    // a bare comma -- fine for most proposedDiff values, but a decision's
    // stakeholders array reads as "Ops lead,CFO" without this.
    .map(([key, value]) => `${label(key)}: ${formatDiffValue(value, key)}`)
    .join("\n");
}

function formatDiffValue(value: unknown, key?: string): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (key === "dueDate" && typeof value === "string" && !Number.isNaN(Date.parse(value))) return formatDueDate(value);
  if (key === "status" && typeof value === "string") return value.replace(/_/g, " ");
  return Array.isArray(value) ? value.join(", ") : String(value);
}

// Pending-review-only variant: renders "field: current -> proposed" for any
// key present in both the diff and currentState (see GET /api/suggestions'
// currentState, backend/src/routes/suggestions.ts), so a reviewer can see
// what's actually changing rather than just the proposed value in isolation.
// Falls back to the plain "field: proposed" form for a brand-new entity
// (currentState null) or a key currentState doesn't have.
export function formatDiffWithCurrentState(
  diff: Record<string, unknown>,
  currentState: Record<string, unknown> | null,
): string {
  return Object.entries(diff)
    .filter(([key]) => !HIDDEN_DIFF_KEYS.has(key))
    .map(([key, value]) => {
      const proposed = formatDiffValue(value, key);
      if (currentState && key in currentState) {
        const current = formatDiffValue(currentState[key], key);
        // An unchanged value (e.g. a deadline reminder repeating the same
        // date) must not read like a correction.
        if (current === proposed) return `${label(key)}: ${proposed} (unchanged)`;
        return `${label(key)}: ${current} → ${proposed}`;
      }
      return `${label(key)}: ${proposed}`;
    })
    .join("\n");
}
