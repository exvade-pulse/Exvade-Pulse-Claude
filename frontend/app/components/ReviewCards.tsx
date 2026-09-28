import Link from "next/link";
import type { ReviewDecision, ReviewTask } from "../../lib/api";
import { chipClass, STATUS_LABEL } from "./TaskStatusChips";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function ago(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

// Fixed slot order for every decision: title + status on top, then why it
// matters and the next step (the two lines an executive actually needs),
// then everything else behind "Details".
export function DecisionCard({ decision, deadlinePassed = false }: { decision: ReviewDecision; deadlinePassed?: boolean }) {
  const hasDetails = decision.relevantContext || decision.stakeholders.length > 0 || decision.relatedTask;
  return (
    <article className={`card rc-card${deadlinePassed ? " rc-card-attention" : ""}`}>
      <div className="rc-top">
        <p className="card-title rc-title">{decision.title}</p>
        {deadlinePassed ? (
          <span className="chip chip-attention">Deadline passed</span>
        ) : decision.dueDate ? (
          <span className="chip">Due {formatDate(decision.dueDate)}</span>
        ) : (
          <span className="chip chip-quiet">No due date</span>
        )}
      </div>

      {deadlinePassed && decision.dueDate && (
        <p className="rc-callout">
          Was due {formatDate(decision.dueDate)} ({ago(decision.daysOverdue ?? 0)}) and is still marked open. What actually
          happened?
        </p>
      )}
      {decision.whyItMatters && <p className="rc-line rc-clamp">{decision.whyItMatters}</p>}
      {decision.suggestedNextStep && (
        <p className="rc-line">
          <span className="rc-label">Next</span> {decision.suggestedNextStep}
        </p>
      )}
      <p className="rc-meta">Decider: {decision.decider}</p>

      {hasDetails && (
        <details className="rc-details">
          <summary>Details</summary>
          {decision.relevantContext && <p className="rc-line">{decision.relevantContext}</p>}
          {decision.stakeholders.length > 0 && <p className="rc-meta">Stakeholders: {decision.stakeholders.join(", ")}</p>}
          {decision.relatedTask && <p className="rc-meta">Related task: {decision.relatedTask}</p>}
        </details>
      )}

      <div className="card-actions">
        <Link className="decision-btn" href="/decisions">
          {deadlinePassed ? "Record what happened" : "Open in Decisions"}
        </Link>
      </div>
    </article>
  );
}

// One task per row: status and title first, then the next action, owner and
// how fresh its evidence is. Why it was ranked where it is lives behind
// "Why this is here" -- the score is supporting detail, not the headline.
export function TaskRow({ task, showWhy = true }: { task: ReviewTask; showWhy?: boolean }) {
  return (
    <div className="task-row rc-task">
      <div className="task-row-top">
        <Link className="task-row-title" href={`/tasks/${task.id}`}>
          {task.title}
        </Link>
        <span className={chipClass(task.status)}>{STATUS_LABEL[task.status]}</span>
      </div>
      <p className="task-row-meta">
        {task.project} · Owner: {task.owner ?? "not recorded"} · Last evidence {ago(task.daysSinceEvidence)}
      </p>
      {task.waitingOnDecision && (
        <p className="rc-line">
          <span className="rc-label">Waiting on</span> {task.waitingOnDecision}
        </p>
      )}
      {task.nextAction && (
        <p className="rc-line">
          <span className="rc-label">Next</span> {task.nextAction}
        </p>
      )}
      {showWhy && (
        <details className="rc-details">
          <summary>Why this is here</summary>
          <p className="rc-meta">
            Attention {task.attentionScore}/100
            {task.attentionReasons.length > 0 ? `: ${task.attentionReasons.join(", ")}` : ""}
          </p>
          {task.latestUpdate && <p className="rc-line">{task.latestUpdate}</p>}
        </details>
      )}
    </div>
  );
}
