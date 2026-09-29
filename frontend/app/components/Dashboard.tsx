import Link from "next/link";
import type { DashboardChange, DashboardItem, DashboardPriority, DashState } from "../../lib/api";
import { chipClass, STATUS_LABEL } from "./TaskStatusChips";

// Label + symbol, never color alone.
const STATE: Record<DashState, { icon: string; label: string; className: string }> = {
  "needs action": { icon: "●", label: "Needs action", className: "state-action" },
  "upcoming deadline": { icon: "◷", label: "Deadline", className: "state-deadline" },
  waiting: { icon: "⏸", label: "Waiting", className: "state-waiting" },
  "recently changed": { icon: "↻", label: "Changed", className: "state-changed" },
  "on track": { icon: "✓", label: "On track", className: "state-ok" },
  resolved: { icon: "✔", label: "Resolved", className: "state-resolved" },
};

export function StateBadge({ state }: { state: DashState }) {
  const s = STATE[state];
  return (
    <span className={`state-badge ${s.className}`}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
    </span>
  );
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export function itemHref(kind: string, id: string): string {
  return kind === "task" ? `/tasks/${id}` : kind === "question" ? "/questions" : "/decisions";
}

// One executive priority: what it is, where it stands, the one next action,
// who owns it and what it hinges on. Everything else is behind "Details".
export function PriorityCard({ priority: p }: { priority: DashboardPriority }) {
  const d = p.details;
  const detailCount = d.decisions.length + d.work.length + d.recent.length;
  return (
    <article className={`card priority-card ${STATE[p.state].className}-edge`}>
      <div className="priority-top">
        <h3 className="priority-title" title={p.title}>
          {p.title}
        </h3>
        <StateBadge state={p.state} />
      </div>
      <p className="priority-objective" title={p.objective}>
        {p.objective}
      </p>

      {p.nextAction ? (
        <div className={`next-action${p.nextActionIsMine ? " next-action-mine" : ""}`}>
          <span className="next-action-label">{p.nextActionIsMine ? "Your next action" : "Next action"}</span>
          <span className="next-action-text">{p.nextAction}</span>
        </div>
      ) : (
        p.state !== "resolved" && <p className="next-action-missing">No next action recorded</p>
      )}

      <dl className="priority-meta">
        {p.owner && (
          <div>
            <dt>Owner</dt>
            <dd>{p.owner}</dd>
          </div>
        )}
        {p.keyDate && (
          <div>
            <dt>Key date</dt>
            <dd title={p.keyDate.label}>
              <strong>{shortDate(p.keyDate.date)}</strong> · {p.keyDate.label}
            </dd>
          </div>
        )}
        {p.keyDependency && (
          <div>
            <dt>Depends on</dt>
            <dd>{p.keyDependency}</dd>
          </div>
        )}
      </dl>

      {detailCount > 0 && (
        <details className="priority-details">
          <summary>
            Details
            <span className="muted">
              {" "}
              · {[p.stateDetail, d.work.length && `${d.work.length} work item${d.work.length === 1 ? "" : "s"}`, d.recent.length && `${d.recent.length} update${d.recent.length === 1 ? "" : "s"}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </summary>
          {d.hypothesis && (
            <p className="rc-line">
              <span className="rc-label">Hypothesis</span> {d.hypothesis}
            </p>
          )}
          {d.decisions.length > 0 && (
            <>
              <p className="priority-sub">Decisions</p>
              <ul className="dash-list">
                {d.decisions.map((x) => (
                  <li key={x.id}>
                    <Link href="/decisions">{x.title}</Link>
                    <span className="muted">
                      {" "}
                      · {x.decider}
                      {x.dueDate && (x.overdue ? ` · was due ${shortDate(x.dueDate)}` : ` · due ${shortDate(x.dueDate)}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.work.length > 0 && (
            <>
              <p className="priority-sub">Work</p>
              <ul className="dash-list">
                {d.work.map((w) => (
                  <li key={w.id}>
                    <span className={chipClass(w.status as keyof typeof STATUS_LABEL)}>{STATUS_LABEL[w.status as keyof typeof STATUS_LABEL] ?? w.status}</span>{" "}
                    <Link href={`/tasks/${w.id}`}>{w.title}</Link>
                    {(w.nextAction || w.owner) && (
                      <span className="muted">
                        {w.owner && ` · ${w.owner}`}
                        {w.nextAction && ` · next: ${w.nextAction}`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.recent.length > 0 && (
            <>
              <p className="priority-sub">Recent updates</p>
              <ChangeList changes={d.recent} />
            </>
          )}
          {p.kind === "question" && (
            <p className="rc-meta">
              <Link href="/questions">Edit in Questions</Link>
            </p>
          )}
        </details>
      )}
    </article>
  );
}

export function ChangeList({ changes }: { changes: DashboardChange[] }) {
  return (
    <ul className="dash-list">
      {changes.map((c) => (
        <li key={`${c.recordType}:${c.recordId}`} title={`${c.about}: ${c.text}`}>
          <span className="dash-date">{shortDate(c.date)}</span>{" "}
          <Link href={itemHref(c.recordType, c.recordId)}>{c.about}</Link>
          <span className="dash-change-text">: {c.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function ItemList({ items, empty }: { items: DashboardItem[]; empty: string }) {
  if (items.length === 0) return <p className="empty-inline">{empty}</p>;
  return (
    <ul className="dash-list">
      {items.map((i) => (
        <li key={`${i.kind}:${i.id}`} title={`${i.title} · ${i.detail}`}>
          <span className="dash-kind">{i.kind === "decision" ? "Decision" : "Task"}</span>{" "}
          <Link href={itemHref(i.kind, i.id)}>{i.title}</Link>
          {i.date && <span className="dash-date"> · due {shortDate(i.date)}</span>}
          <span className="dash-detail"> · {i.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export { longDate };
