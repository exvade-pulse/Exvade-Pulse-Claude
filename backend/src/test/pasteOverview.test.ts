import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, decisions, milestones, objectiveHealthHistory, objectives, risks, suggestions } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { approveSuggestion, SuggestionApplyError } from "../suggestions/apply.js";
import { setClaudeClientForTesting } from "../interpretation/claudeClient.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;

function toolUse(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

async function cookieFor(f: Fixture) {
  await db.update(authorizedUsers).set({ role: "admin" }).where(eq(authorizedUsers.id, f.authorization.id));
  return { [SESSION_COOKIE_NAME]: await signSession({ userId: f.user.id, organizationId: f.org.id, email: f.user.email, role: "admin" }) };
}

async function runFindings(f: Fixture, text: string, changes: unknown[]) {
  setClaudeClientForTesting({
    createMessage: async (params) =>
      params.tool_choice?.type === "tool"
        ? toolUse("redact_text", { redactedText: String(params.messages[0].content) })
        : toolUse("propose_corrections", { changes, unresolved: [], appFeedback: [] }),
  });
  const app = await buildApp();
  const cookies = await cookieFor(f);
  let job = (await app.inject({ method: "POST", url: "/api/reviews/findings", cookies, payload: { text } })).json();
  for (let i = 0; i < 50 && job.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 50));
    job = (await app.inject({ method: "GET", url: `/api/reviews/findings/${job.id}`, cookies })).json();
  }
  setClaudeClientForTesting(undefined);
  await app.close();
  return job;
}

describe("Pasting Executive Overview updates into Review", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("turns outcome, milestone, risk and decision lines into cards that fill in the overview when approved", async () => {
    const f = await createFixtureOrg(db, { domain: "paste-overview.test" });
    const other = (await db.insert(objectives).values({ organizationId: f.org.id, title: "Protect and expand strategic value" }).returning())[0];
    const [existing] = await db
      .insert(milestones)
      .values({ organizationId: f.org.id, objectiveId: f.objective.id, title: "Acceptance criteria agreed", forecastDate: new Date("2026-11-15T00:00:00Z"), confidence: "forecast" })
      .returning();
    const [elsewhere] = await db.insert(milestones).values({ organizationId: f.org.id, objectiveId: other.id, title: "US filing" }).returning();
    const [decision] = await db.insert(decisions).values({ organizationId: f.org.id, title: "Choose study partner", decider: "CEO" }).returning();

    const job = await runFindings(f, "OUTCOME: Test objective\nHealth: At risk\n...", [
      { action: "update", targetType: "objective", targetId: f.objective.id, fields: { health: "at_risk", healthRationale: "Sample result unexplained", rationale: "Proves sampling works", displayOrder: "1" }, reasoning: "template", confidence: 0.9 },
      { action: "update", targetType: "objective", targetId: other.id, fields: { health: "blocked" }, reasoning: "no reason given", confidence: 0.9 },
      // Same forecast as recorded: not a change, so no card.
      { action: "update", targetType: "milestone", targetId: existing.id, fields: { forecastDate: "2026-11-15" }, reasoning: "unchanged", confidence: 0.9 },
      { action: "create", targetType: "milestone", fields: { objectiveId: f.objective.id, title: "Needle size chosen", baselineDate: "2026-12-01", confidence: "committed", successCriteria: "Two sizes pass" }, reasoning: "new", confidence: 0.9 },
      // A milestone from a different outcome is dropped from the risk.
      { action: "create", targetType: "risk", fields: { objectiveId: f.objective.id, title: "Single supplier", impact: "Delays verification", escalation: "decision_needed", milestoneId: elsewhere.id }, reasoning: "new", confidence: 0.9 },
      { action: "update", targetType: "decision", targetId: decision.id, fields: { objectiveId: f.objective.id, recommendation: "Duke", impactOfDelay: "Slips a quarter" }, reasoning: "attach", confidence: 0.9 },
    ]);

    expect(job.status).toBe("done");
    expect(job.proposals).toBe(4);
    expect(job.unresolved).toEqual([{ text: 'Health for "Protect and expand strategic value"', reason: "A health rating needs a one-line reason (Why:)." }]);

    const rows = await db.select().from(suggestions).where(eq(suggestions.organizationId, f.org.id));
    expect(rows.map((r) => r.targetType).sort()).toEqual(["decision", "milestone", "objective", "risk"]);
    expect(rows.find((r) => r.targetType === "risk")!.proposedDiff).not.toHaveProperty("milestoneId");

    for (const r of rows) await approveSuggestion(db, { organizationId: f.org.id, suggestionId: r.id, reviewerId: f.user.id, reviewerRole: "admin" });

    const [o] = await db.select().from(objectives).where(eq(objectives.id, f.objective.id));
    expect(o).toMatchObject({ health: "at_risk", healthRationale: "Sample result unexplained", rationale: "Proves sampling works", displayOrder: 1, healthAssessedBy: "Test Reviewer" });
    const history = await db.select().from(objectiveHealthHistory).where(eq(objectiveHealthHistory.objectiveId, f.objective.id));
    expect(history).toMatchObject([{ health: "at_risk", source: "review" }]);
    const ms = await db.select().from(milestones).where(eq(milestones.title, "Needle size chosen"));
    expect(ms[0]).toMatchObject({ objectiveId: f.objective.id, confidence: "committed", successCriteria: "Two sizes pass" });
    expect(ms[0].baselineDate?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    const [risk] = await db.select().from(risks);
    expect(risk).toMatchObject({ title: "Single supplier", escalation: "decision_needed", milestoneId: null });
    const [d] = await db.select().from(decisions).where(eq(decisions.id, decision.id));
    expect(d).toMatchObject({ objectiveId: f.objective.id, recommendation: "Duke", impactOfDelay: "Slips a quarter" });
  });

  it("only an admin's approval can move a committed baseline", async () => {
    const f = await createFixtureOrg(db, { domain: "paste-baseline.test" });
    const [m] = await db
      .insert(milestones)
      .values({ organizationId: f.org.id, objectiveId: f.objective.id, title: "Verification", baselineDate: new Date("2026-12-01T00:00:00Z") })
      .returning();
    const [row] = await db
      .insert(suggestions)
      .values({ organizationId: f.org.id, sourceId: f.source.id, targetType: "milestone", targetId: m.id, changeType: "operational_update", proposedDiff: { baselineDate: "2027-01-15" }, reasoning: "x", confidence: 0.9 })
      .returning();
    await expect(approveSuggestion(db, { organizationId: f.org.id, suggestionId: row.id, reviewerId: f.user.id, reviewerRole: "member" })).rejects.toThrow(SuggestionApplyError);
    await approveSuggestion(db, { organizationId: f.org.id, suggestionId: row.id, reviewerId: f.user.id, reviewerRole: "admin" });
    const [after] = await db.select().from(milestones).where(eq(milestones.id, m.id));
    expect(after.baselineDate?.toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  it("writes the current overview out in the paste format", async () => {
    const f = await createFixtureOrg(db, { domain: "paste-template.test" });
    await db.update(objectives).set({ health: "at_risk", healthRationale: "Supplier", rationale: "Why", owner: "Sean", displayOrder: 1 }).where(eq(objectives.id, f.objective.id));
    await db.insert(objectives).values({ organizationId: f.org.id, title: "Unsorted / Needs Triage" });
    const [m] = await db
      .insert(milestones)
      .values({ organizationId: f.org.id, objectiveId: f.objective.id, title: "Verification", baselineDate: new Date("2026-12-01T00:00:00Z"), forecastDate: new Date("2027-01-12T00:00:00Z"), confidence: "forecast", owner: "Jack" })
      .returning();
    await db.insert(risks).values({ organizationId: f.org.id, objectiveId: f.objective.id, milestoneId: m.id, title: "Single supplier", mitigation: "Second source", escalation: "decision_needed" });
    await db.insert(decisions).values({ organizationId: f.org.id, title: "Pick partner", decider: "CEO", objectiveId: f.objective.id, recommendation: "Duke" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/overview/template", cookies: await cookieFor(f) });
    await app.close();
    expect(res.json().text).toBe(
      [
        "OUTCOME: Test objective",
        "Health: At risk",
        "Why: Supplier",
        "Why it matters: Why",
        "Owner: Sean",
        "Order: 1",
        "Milestones:",
        "- Verification | baseline 2026-12-01 | forecast 2027-01-12 | confidence forecast | owner Jack",
        "Risks:",
        "- Single supplier | mitigation: Second source | decision needed | affects: Verification",
        "Decisions:",
        "- Pick partner | recommendation: Duke",
      ].join("\n"),
    );
  });
});
