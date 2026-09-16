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
