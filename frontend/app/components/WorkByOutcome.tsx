"use client";

import Link from "next/link";
import type { OutcomeWork, WorkRow } from "../../lib/api";
import { formatDueDate } from "../../lib/dates";

// Operating Detail's working view: every open task under its outcome, in the
// leadership-set order, split into what's mine, the team's, waiting on
// someone else, and blocked. Unknown owners, dates and waiting parties say
// so instead of being left blank.

const BUCKETS: Array<[keyof Pick<OutcomeWork, "mine" | "team" | "waiting" | "blocked">, string, string]> = [
  ["blocked", "Blocked", "Nothing marked blocked."],
  ["mine", "My actions", "Nothing assigned to you."],
  ["waiting", "Waiting on others", "Nothing recorded as waiting on someone."],
  ["team", "Team actions", "No other open work."],
];

function Row({ row }: { row: WorkRow }) {
  return (
    <li>
      <Link href={`/tasks/${row.id}`} className="wbo-title">
        {row.title}
      </Link>
      <span className="wbo-meta">
        {row.nextAction ? (
          <>
            Next: {row.nextAction}
            {row.nextActionStale && <span className="wbo-stale"> (may be stale)</span>}
          </>
        ) : (
          <span className="wbo-unset">Next action not set</span>
        )}
      </span>
      <span className="wbo-meta">
        {row.owner ?? <span className="wbo-unset">owner not set</span>}
        {row.waitingOn ? ` · waiting on ${row.waitingOn}` : ""}
        {" · "}
        {row.dueDate ? (
          <>
            {row.dueLabel ? `${row.dueLabel} ` : ""}
            {formatDueDate(row.dueDate)} ({row.dueDateType ?? "date type not set"})
          </>
        ) : (
          <span className="wbo-unset">no date</span>
        )}
        {" · "}
        {row.project}
      </span>
    </li>
  );
}

export function WorkByOutcome({ groups }: { groups: OutcomeWork[] }) {
  if (groups.length === 0) return <p className="empty-inline">No open work recorded.</p>;
  return (
    <div className="wbo">
      {groups.map((g) => (
        <details key={g.objective} className="card wbo-outcome" open={g.blocked.length > 0 || g.mine.length > 0}>
          <summary>
            <span className="wbo-name">
              {g.objectiveOrder ? `${g.objectiveOrder}. ` : ""}
              {g.objective}
            </span>
            <span className="muted">
              {" "}
              · {g.total} open · {g.blocked.length} blocked · {g.mine.length} mine · {g.waiting.length} waiting · {g.team.length} team
            </span>
          </summary>
          <div className="wbo-buckets">
            {BUCKETS.map(([key, label, empty]) => (
              <section key={key} className={`wbo-bucket wbo-${key}`} aria-label={`${g.objective}: ${label}`}>
                <h3 className="wbo-bucket-title">
                  {label} ({g[key].length})
                </h3>
                {g[key].length === 0 ? (
                  <p className="empty-inline">{empty}</p>
                ) : (
                  <ul className="wbo-list">
                    {g[key].map((row) => (
                      <Row key={row.id} row={row} />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
