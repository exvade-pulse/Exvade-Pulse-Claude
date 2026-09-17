// Foreign keys (objectiveId, projectId, ...) are implementation detail, not
// something a reader needs to see -- "where it belongs" is already conveyed
// elsewhere (the "Proposes new X" / "Updates existing X" line on a suggestion
// card, or a task's own breadcrumb).
export const HIDDEN_DIFF_KEYS = new Set(["objectiveId", "initiativeId", "projectId"]);

// Shared by the review page's pending/history suggestion cards and the task
// detail page's approved-suggestion history, so "what changed" reads the same
// way everywhere a proposedDiff is shown.
export function formatDiff(diff: Record<string, unknown>): string {
  return Object.entries(diff)
    .filter(([key]) => !HIDDEN_DIFF_KEYS.has(key))
    // Array.prototype.toString() (what String(value) falls back to) joins with
    // a bare comma -- fine for most proposedDiff values, but a decision's
    // stakeholders array reads as "Ops lead,CFO" without this.
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("\n");
}

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
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
      const proposed = formatDiffValue(value);
      if (currentState && key in currentState) {
        return `${key}: ${formatDiffValue(currentState[key])} → ${proposed}`;
      }
      return `${key}: ${proposed}`;
    })
    .join("\n");
}
