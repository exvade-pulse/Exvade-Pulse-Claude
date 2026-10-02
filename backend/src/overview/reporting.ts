import type Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database, DbOrTx } from "../db/client.js";
import { auditLog, milestones, objectives, reportingSnapshots } from "../db/schema.js";
import type { ClaudeClient } from "../interpretation/claudeClient.js";
import type { ExecutiveOverview, SnapshotSummary } from "../reports/executiveOverview.js";
import { OverviewError } from "./manage.js";

// Reporting periods: publishing freezes the summary paragraph plus a compact
// record of every outcome's health and milestone date, which the overview's
// "what changed" compares against until the next publication. The AI may
// draft the paragraph; only a person publishes it.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRIAGE = /^unsorted\b/i;
export const NARRATIVE_MODEL = "claude-sonnet-5";

const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function currentSummary(tx: DbOrTx, organizationId: string): Promise<SnapshotSummary> {
  const objectiveRows = (
    await tx
      .select({ id: objectives.id, title: objectives.title, health: objectives.health })
      .from(objectives)
      .where(and(eq(objectives.organizationId, organizationId), inArray(objectives.status, ["active", "paused"])))
  ).filter((o) => !TRIAGE.test(o.title));
  const ids = objectiveRows.map((o) => o.id);
  const milestoneRows = ids.length
    ? await tx.select().from(milestones).where(and(eq(milestones.organizationId, organizationId), inArray(milestones.objectiveId, ids)))
    : [];
  return {
    objectives: objectiveRows,
    milestones: milestoneRows.map((m) => {
      const date = m.state === "achieved" && m.actualDate ? m.actualDate : (m.forecastDate ?? m.baselineDate);
      return { id: m.id, title: m.title, date: date ? date.toISOString().slice(0, 10) : null, state: m.state };
    }),
  };
}

// The period runs from the day after the last publication (or 30 days back
// for the first one) to today.
export async function publishSnapshot(
  db: Database,
  a: { organizationId: string; actorId: string },
  body: { narrative?: unknown },
) {
  const narrative = typeof body.narrative === "string" ? body.narrative.trim().slice(0, 2000) : "";
  if (!narrative) throw new OverviewError("Write the summary paragraph before publishing");
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ periodEnd: reportingSnapshots.periodEnd })
      .from(reportingSnapshots)
      .where(eq(reportingSnapshots.organizationId, a.organizationId))
      .orderBy(desc(reportingSnapshots.publishedAt))
      .limit(1);
    const today = startOfDay(new Date());
    const periodStart = last ? new Date(Math.min(startOfDay(last.periodEnd).getTime() + MS_PER_DAY, today.getTime())) : new Date(today.getTime() - 30 * MS_PER_DAY);
    const summary = await currentSummary(tx, a.organizationId);
    const [row] = await tx
      .insert(reportingSnapshots)
      .values({ organizationId: a.organizationId, periodStart, periodEnd: today, narrative, summary, publishedBy: a.actorId })
      .returning();
    await tx.insert(auditLog).values({
      organizationId: a.organizationId,
      actorId: a.actorId,
      action: "overview.published",
      entityType: "reporting_snapshot",
      entityId: row.id,
      details: { periodStart, periodEnd: today },
    });
    return row;
  });
}

const DRAFT_TOOL: Anthropic.Tool = {
  name: "draft_summary",
  description: "Return the draft summary paragraph.",
  input_schema: {
    type: "object",
    properties: { paragraph: { type: "string", description: "60 to 90 words, plain prose, no headings or bullets." } },
    required: ["paragraph"],
  },
};

// A starting draft for the person publishing. Built only from the overview
// itself, and told to say "not yet assessed" rather than guess.
export async function draftNarrative(overview: ExecutiveOverview, claudeClient: ClaudeClient): Promise<string> {
  const facts = {
    outcomes: overview.outcomes.map((o) => ({
      outcome: o.title,
      health: o.health,
      reason: o.healthRationale,
      stale: o.stale,
      trend: o.trend,
      nextMilestone: o.nextMilestone ? `${o.nextMilestone.title} (${o.nextMilestone.date}, ${o.nextMilestone.confidence})` : null,
    })),
    leadershipAttention: overview.attention.map((i) => `${i.title}: ${i.detail}`),
    changesSinceLastReview: overview.changes,
    topRisks: overview.topRisks.map((r) => `${r.title}${r.impact ? ` (impact: ${r.impact})` : ""}`),
  };
  const response = await claudeClient.createMessage({
    model: NARRATIVE_MODEL,
    max_tokens: 1500,
    tool_choice: { type: "tool", name: DRAFT_TOOL.name },
    tools: [DRAFT_TOOL],
    messages: [
      {
        role: "user",
        content: `Draft the opening paragraph of the company's executive overview, for a senior leader who checks in every few weeks.

In 60 to 90 words of plain prose: what the company is working toward, the most important change since the last review, what most needs leadership attention, and the next major milestone.

Use only the facts below. Do not invent dates, numbers or outcomes. Where an outcome is "not_assessed" or stale, say its status isn't confirmed rather than guessing. No jargon, no bullet points.

Facts:
${JSON.stringify(facts, null, 2)}`,
      },
    ],
  });
  const tool = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const paragraph = (tool?.input as { paragraph?: unknown } | undefined)?.paragraph;
  if (typeof paragraph !== "string" || !paragraph.trim()) throw new OverviewError("The AI didn't return a draft; try again or write it yourself.");
  return paragraph.trim();
}
