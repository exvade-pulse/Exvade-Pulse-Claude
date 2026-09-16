import type { TaskCounts, TaskStatus } from "../../lib/api";

// Workflow order, not alphabetical -- what needs eyes on it (active work, then
// trouble) reads before what's settled (resolved/completed/superseded).
const STATUS_ORDER: TaskStatus[] = [
  "active",
  "needs_attention",
  "blocked",
  "waiting",
  "resolved",
  "completed",
  "superseded",
];

// Exported for reuse by anything rendering a single task's status outside the
// full chip-row breakdown (the dashboard's Needs Attention/Recent Progress
// rows), so the wording/coloring for a given status stays in one place.
export const STATUS_LABEL: Record<TaskStatus, string> = {
  active: "active",
  waiting: "waiting",
  needs_attention: "needs attention",
  completed: "completed",
  superseded: "superseded",
  resolved: "resolved",
  blocked: "blocked",
};

export function chipClass(status: TaskStatus): string {
  if (status === "needs_attention" || status === "blocked") return "chip chip-attention";
  if (status === "completed") return "chip chip-done";
  return "chip";
}

// The same "what's the state of everything under here" chip breakdown at
// every level of the hierarchy -- originally the dashboard's objective
// cards, now shared with the initiative/project detail pages too.
export function TaskStatusChips({ counts }: { counts: TaskCounts }) {
  const activeStatuses = STATUS_ORDER.filter((status) => counts[status] > 0);

  if (activeStatuses.length === 0) {
    return <p className="muted">No tasks yet.</p>;
  }

  return (
    <div className="chip-row">
      {activeStatuses.map((status) => (
        <span className={chipClass(status)} key={status}>
          {counts[status]} {STATUS_LABEL[status]}
        </span>
      ))}
    </div>
  );
}
