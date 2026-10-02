"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDay, type Outcome, type RoadmapMilestone } from "../../../lib/overview";
import { outcomeHref } from "./Parts";

// The strategic roadmap: one lane per outcome across the next four
// quarters, milestones as diamonds (achieved / committed / forecast /
// unconfirmed), a Today line, and slips shown against the baseline. The
// Now/Next/Later and List views carry the same information as text; phones
// get the list.

type View = "quarters" | "nnl" | "list";
const MS_PER_DAY = 86400000;
const VIEW_KEY = "pulse.roadmapView";

const utc = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`).getTime();

function quarterStart(d: Date) {
  return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
}

function quarters(now: Date) {
  const first = new Date(quarterStart(now));
  return Array.from({ length: 4 }, (_, i) => {
    const start = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i * 3, 1);
    const d = new Date(start);
    return { start, label: `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}` };
  });
}

function marker(m: RoadmapMilestone) {
  if (m.state === "achieved") return "achieved";
  if (m.state === "missed") return "missed";
  return m.confidence;
}

const STATE_TEXT: Record<string, string> = {
  achieved: "Achieved",
  missed: "Missed",
  committed: "Committed",
  forecast: "Forecast",
  unconfirmed: "Unconfirmed",
};

function describe(m: RoadmapMilestone) {
  const slip = m.slipDays && m.slipDays > 0 ? `, ${m.slipDays} days later than the baseline ${formatDay(m.baselineDate)}` : "";
  return `${m.title}: ${formatDay(m.date)} (${STATE_TEXT[marker(m)].toLowerCase()}${slip})`;
}

function MilestoneList({ milestones, outcomes }: { milestones: RoadmapMilestone[]; outcomes: Map<string, Outcome> }) {
  if (milestones.length === 0) return <p className="xo-empty">No dated milestones yet.</p>;
  return (
    <ul className="xo-ms-list">
      {milestones.map((m) => (
        <li key={m.id}>
          <span className="xo-ms-when">{formatDay(m.date)}</span>
          <span>
            <Link href={`${outcomeHref(m.objectiveId)}#milestones`}>{m.title}</Link>
            <span className="xo-attn-detail">
              {outcomes.get(m.objectiveId)?.title} · {STATE_TEXT[marker(m)]}
              {m.slipDays && m.slipDays > 0 ? ` · slipped ${m.slipDays} days` : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StrategicRoadmap({ outcomes, scheduled, unscheduled, asOf }: { outcomes: Outcome[]; scheduled: RoadmapMilestone[]; unscheduled: RoadmapMilestone[]; asOf: string }) {
  const [view, setView] = useState<View>("quarters");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "quarters" || saved === "nnl" || saved === "list") setView(saved);
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);
  function choose(v: View) {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  }

  const now = new Date(asOf);
  const qs = quarters(now);
  const start = qs[0].start;
  const end = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 12, 1);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100));
  const todayPct = pct(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const byOutcome = new Map(outcomes.map((o) => [o.id, o]));
  const inWindow = scheduled.filter((m) => m.date && utc(m.date) < end && (utc(m.date) >= start || m.state === "planned"));
  const beyond = scheduled.filter((m) => m.date && utc(m.date) >= end);

  const nextQuarterStart = qs[1].start;
  const afterNext = qs[2].start;
  const planned = scheduled.filter((m) => m.state === "planned");
  const nnl = {
    Now: planned.filter((m) => utc(m.date!) < nextQuarterStart),
    Next: planned.filter((m) => utc(m.date!) >= nextQuarterStart && utc(m.date!) < afterNext),
    Later: planned.filter((m) => utc(m.date!) >= afterNext),
  };

  return (
    <section className="xo-card" aria-labelledby="xo-roadmap">
      <div className="xo-row-between">
        <h2 className="xo-label" id="xo-roadmap">
          Strategic roadmap
        </h2>
        <div className="xo-toggle" role="group" aria-label="Roadmap view">
          {(
            [
              ["quarters", "Quarters"],
              ["nnl", "Now / Next / Later"],
              ["list", "List"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" className={view === v ? "xo-on" : ""} aria-pressed={view === v} onClick={() => choose(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "quarters" && (
        <>
          <div className="xo-rm" role="img" aria-label={`Roadmap, ${qs[0].label} to ${qs[3].label}. ${inWindow.map(describe).join(". ") || "No dated milestones."}`}>
            <div className="xo-rm-head">
              <span />
              <div className="xo-rm-qs">
                {qs.map((q) => (
                  <span key={q.label}>{q.label}</span>
                ))}
              </div>
            </div>
            {outcomes.map((o) => (
              <div className="xo-rm-lane" key={o.id}>
                <Link className="xo-rm-name" href={outcomeHref(o.id)}>
                  {o.title}
                </Link>
                <div className="xo-rm-track">
                  <span className="xo-rm-today" style={{ left: `${todayPct}%` }} />
                  {inWindow
                    .filter((m) => m.objectiveId === o.id)
                    .map((m) => {
                      const at = pct(utc(m.date!));
                      const base = m.baselineDate && m.slipDays && m.slipDays > 0 ? pct(utc(m.baselineDate)) : null;
                      return (
                        <span key={m.id}>
                          {base !== null && <span className="xo-rm-slip" style={{ left: `${base}%`, width: `${Math.max(0, at - base)}%` }} />}
                          <Link
                            href={`${outcomeHref(o.id)}#milestones`}
                            className={`xo-dia xo-dia-${marker(m)}`}
                            style={{ left: `${at}%` }}
                            title={describe(m)}
                            aria-label={describe(m)}
                          />
                        </span>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
          <div className="xo-legend" aria-hidden="true">
            <span>
              <i className="xo-dia-key xo-dia-achieved" /> Achieved
            </span>
            <span>
              <i className="xo-dia-key xo-dia-committed" /> Committed
            </span>
            <span>
              <i className="xo-dia-key xo-dia-forecast" /> Forecast
            </span>
            <span>
              <i className="xo-dia-key xo-dia-unconfirmed" /> Unconfirmed
            </span>
            <span>
              <i className="xo-dia-key xo-dia-missed" /> Missed
            </span>
            <span>│ Today</span>
            <span>┄ Moved from baseline</span>
          </div>
          <div className="xo-rm-compact">
            <MilestoneList milestones={inWindow} outcomes={byOutcome} />
          </div>
          {beyond.length > 0 && <p className="xo-meta">Later than shown: {beyond.map((m) => `${m.title} (${formatDay(m.date)})`).join(", ")}</p>}
        </>
      )}

      {view === "nnl" && (
        <div className="xo-nnl">
          {(Object.keys(nnl) as Array<keyof typeof nnl>).map((col) => (
            <div key={col}>
              <h3 className="xo-nnl-head">
                {col} <span className="muted">{col === "Now" ? "this quarter" : col === "Next" ? "next quarter" : "after that"}</span>
              </h3>
              <MilestoneList milestones={nnl[col]} outcomes={byOutcome} />
            </div>
          ))}
        </div>
      )}

      {view === "list" && <MilestoneList milestones={scheduled} outcomes={byOutcome} />}

      <p className="xo-meta">
        <strong>Unscheduled ({unscheduled.length}):</strong>{" "}
        {unscheduled.length ? unscheduled.map((m) => `${m.title} (${byOutcome.get(m.objectiveId)?.title ?? "outcome"})`).join(" · ") : "none"}
      </p>
    </section>
  );
}
