import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { decisions, milestones, objectives, risks, UNDECIDED_DECISION_STATUSES, type UserRole } from "../db/schema.js";
import { visibilityFilter } from "../access/visibility.js";

// The current Executive Overview written out in the paste format (see the
// format guide next to "Paste review findings"), so someone can copy it,
// edit what changed and paste it back. Pasting it unchanged proposes
// nothing new.

const TRIAGE = /^unsorted\b/i;
const HEALTH_TEXT = { on_track: "On track", at_risk: "At risk", blocked: "Blocked", not_assessed: "Not assessed" } as const;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const piece = (label: string, value: string | null | undefined) => (value ? `${label}${value}` : null);
const line = (parts: Array<string | null>) => `- ${parts.filter(Boolean).join(" | ")}`;

export async function buildPasteTemplate(db: DbOrTx, organizationId: string, role: UserRole): Promise<string> {
  const outcomeRows = (
    await db
      .select()
      .from(objectives)
      .where(and(eq(objectives.organizationId, organizationId), inArray(objectives.status, ["active", "paused"])))
      .orderBy(asc(objectives.displayOrder), asc(objectives.createdAt))
  ).filter((o) => !TRIAGE.test(o.title));
  const ids = outcomeRows.map((o) => o.id);
  if (ids.length === 0) return "";

  const [milestoneRows, riskRows, decisionRows] = await Promise.all([
    db
      .select()
      .from(milestones)
      .where(and(eq(milestones.organizationId, organizationId), inArray(milestones.objectiveId, ids), ne(milestones.state, "dropped")))
      .orderBy(asc(milestones.createdAt)),
    db
      .select()
      .from(risks)
      .where(and(eq(risks.organizationId, organizationId), inArray(risks.objectiveId, ids), eq(risks.status, "open")))
      .orderBy(asc(risks.createdAt)),
    db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.organizationId, organizationId),
          inArray(decisions.objectiveId, ids),
          inArray(decisions.status, UNDECIDED_DECISION_STATUSES),
          visibilityFilter(role, decisions.visibility),
        ),
      ),
  ]);
  const milestoneTitle = new Map(milestoneRows.map((m) => [m.id, m.title]));

  const blocks = outcomeRows.map((o, i) => {
    const out = [
      `OUTCOME: ${o.title}`,
      `Health: ${HEALTH_TEXT[o.health]}`,
      `Why: ${o.healthRationale ?? ""}`,
      `Why it matters: ${o.rationale ?? ""}`,
      `Owner: ${o.owner ?? ""}`,
      `Order: ${o.displayOrder ?? i + 1}`,
      "Milestones:",
    ];
    for (const m of milestoneRows.filter((x) => x.objectiveId === o.id)) {
      out.push(
        line([
          m.title,
          piece("baseline ", day(m.baselineDate)),
          piece("forecast ", day(m.forecastDate)),
          `confidence ${m.confidence}`,
          m.state === "achieved" ? `achieved ${day(m.actualDate) ?? ""}`.trim() : m.state === "planned" ? null : m.state,
          piece("owner ", m.owner),
          piece("done when: ", m.successCriteria),
        ]),
      );
    }
    out.push("Risks:");
    for (const r of riskRows.filter((x) => x.objectiveId === o.id)) {
      out.push(
        line([
          r.title,
          piece("impact: ", r.impact),
          piece("likelihood: ", r.likelihood),
          piece("mitigation: ", r.mitigation),
          piece("owner ", r.owner),
          piece("review by ", day(r.nextReviewAt)),
          r.escalation === "decision_needed" ? "decision needed" : "watching",
          piece("affects: ", r.milestoneId ? milestoneTitle.get(r.milestoneId) : null),
        ]),
      );
    }
    out.push("Decisions:");
    for (const d of decisionRows.filter((x) => x.objectiveId === o.id)) {
      out.push(line([d.title, piece("recommendation: ", d.recommendation), piece("if delayed: ", d.impactOfDelay)]));
    }
    return out.join("\n");
  });
  return blocks.join("\n\n");
}
