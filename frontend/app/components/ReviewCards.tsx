import Link from "next/link";
import type { ReviewContradiction, ReviewDecision, ReviewTask, ReviewWorkstream } from "../../lib/api";
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
  const hasDetails =
    decision.relevantContext || decision.stakeholders.length > 0 || decision.relatedTask || decision.informedBy.length > 0;
  return (
    <article className={`card rc-card${deadlinePassed ? " rc-card-attention" : ""}`}>
      <div className="rc-top">
        <p className="card-title rc-title">{decision.title}</p>
        {deadlinePassed ? (
          <span className="chip chip-attention">Deadline passed</span>
        ) : decision.status === "pending_info" ? (
          <span className="chip">Waiting on info</span>
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
          {decision.nextStepStale && <span className="stale-note"> may be stale ({decision.nextStepAgeDays} days old)</span>}
        </p>
      )}
      {decision.waitingOn.length > 0 && (
        <p className="rc-line">
          <span className="rc-label">Waiting on</span> {decision.waitingOn.join(" · ")}
        </p>
      )}
      {decision.coupledWith.length > 0 && (
        <p className="rc-meta">Consider together with: {decision.coupledWith.join(" · ")}</p>
      )}
      <p className="rc-meta">Decider: {decision.decider}</p>

      {hasDetails && (
        <details className="rc-details">
          <summary>Details</summary>
          {decision.relevantContext && <p className="rc-line">{decision.relevantContext}</p>}
          {decision.stakeholders.length > 0 && <p className="rc-meta">Stakeholders: {decision.stakeholders.join(", ")}</p>}
          {decision.relatedTask && <p className="rc-meta">Related task: {decision.relatedTask}</p>}
          {decision.informedBy.length > 0 && <p className="rc-meta">Informed by: {decision.informedBy.join(" · ")}</p>}
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

// Recorded vs newer, side by side, and the correction waiting for approval.
// Uses the same restrained attention edge as a passed deadline: until it's
// resolved, the record can't be relied on.
export function ContradictionCard({ contradiction: c }: { contradiction: ReviewContradiction }) {
  const recordHref = c.recordType === "task" ? `/tasks/${c.recordId}` : "/decisions";
  return (
    <article className="card rc-card rc-card-attention">
      <div className="rc-top">
        <p className="card-title rc-title">
          <Link className="card-title-link" href={recordHref}>
            {c.recordTitle}
          </Link>
        </p>
        <span className="chip chip-attention">Conflict</span>
      </div>
      <p className="rc-line">
        <span className="rc-label">Recorded{c.olderDate ? ` · ${formatDate(c.olderDate)}` : ""}</span> {c.olderStatement}
      </p>
      <p className="rc-line">
        <span className="rc-label">Newer{c.newerDate ? ` · ${formatDate(c.newerDate)}` : ""}</span> {c.newerStatement}
      </p>
      <details className="rc-details">
        <summary>Proposed correction</summary>
        <p className="rc-line">{c.correctedValue}</p>
      </details>
      <div className="card-actions">
        <Link className="decision-btn" href="/review">
          Resolve in Review
        </Link>
      </div>
    </article>
  );
}

// A workstream (project) as one line: its state and task mix up front, the
// individual tasks behind an expander -- the executive view shows the
// workstream, the operating detail stays one click away.
export function WorkstreamCard({ workstream: w }: { workstream: ReviewWorkstream }) {
  const c = w.counts;
  const mix = [
    c.blocked > 0 && `${c.blocked} blocked`,
    c.needsAttention > 0 && `${c.needsAttention} need attention`,
    c.waiting > 0 && `${c.waiting} waiting`,
    c.active > 0 && `${c.active} active`,
  ].filter(Boolean);
  const staleNext = w.tasks.filter((t) => t.nextActionStale).length;
  return (
    <article className={`card rc-card${w.state === "needs attention" ? " rc-card-attention" : ""}`}>
      <div className="rc-top">
        <p className="card-title rc-title">{w.project}</p>
        <span className={w.state === "needs attention" ? "chip chip-attention" : w.state === "waiting" ? "chip" : "chip chip-done"}>
          {w.state}
        </span>
      </div>
      <p className="rc-meta">
        {w.objective} · {mix.join(", ")}
        {staleNext > 0 && <span className="stale-note"> · {staleNext} next action{staleNext === 1 ? "" : "s"} may be stale</span>}
      </p>
      <details className="rc-details">
        <summary>
          {w.tasks.length} task{w.tasks.length === 1 ? "" : "s"}
        </summary>
        <div className="task-list">
          {w.tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      </details>
    </article>
  );
}

// One task per row: status and title first, then the next action, owner and
// how fresh its evidence is. Why it was ranked where it is lives behind
// "Why this is here" -- the score is supporting detail, not the headline.
export function TaskRow({
  task,
  showWhy = true,
  children,
}: {
  task: ReviewTask;
  showWhy?: boolean;
  // Optional actions rendered under the row (e.g. disposition buttons).
  children?: React.ReactNode;
}) {
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
      {task.waitingOn.length > 0 && (
        <p className="rc-line">
          <span className="rc-label">Waiting on</span> {task.waitingOn.join(" · ")}
        </p>
      )}
      {task.nextAction && (
        <p className="rc-line">
          <span className="rc-label">Next</span> {task.nextAction}
          {task.nextActionStale && <span className="stale-note"> may be stale ({task.nextActionAgeDays} days old)</span>}
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
      {children}
    </div>
  );
}
