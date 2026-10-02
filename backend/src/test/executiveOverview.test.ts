import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, decisions, milestoneLinks, milestones, objectiveHealthHistory, objectives, reportingSnapshots, risks, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { computeOverview, type OverviewInput } from "../reports/executiveOverview.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

const NOW = new Date("2026-10-02T15:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function objective(id: string, over: Partial<OverviewInput["objectives"][number]> = {}): OverviewInput["objectives"][number] {
  return {
    id,
    title: `Outcome ${id}`,
    rationale: null,
    owner: "Sean",
    health: "not_assessed",
    healthRationale: null,
    healthAssessedAt: null,
    healthAssessedBy: null,
    displayOrder: null,
    createdAt: day("2026-01-01"),
    ...over,
  };
}

function milestone(id: string, objectiveId: string, over: Partial<OverviewInput["milestones"][number]> = {}): OverviewInput["milestones"][number] {
  return {
    id,
    objectiveId,
    title: `Milestone ${id}`,
    owner: null,
    baselineDate: null,
    forecastDate: null,
    actualDate: null,
    confidence: "forecast",
    state: "planned",
    ...over,
  };
}

const empty: OverviewInput = { objectives: [], history: [], milestones: [], milestoneBlockers: [], decisions: [], risks: [], snapshot: null };

describe("computeOverview", () => {
  it("orders outcomes by display order, then creation, and never treats a missing assessment as on track or stale", () => {
    const view = computeOverview(
      {
        ...empty,
        objectives: [
          objective("b", { displayOrder: 2 }),
          objective("c", { createdAt: day("2025-01-01") }),
          objective("a", { displayOrder: 1, health: "on_track", healthRationale: "Fine", healthAssessedAt: day("2026-09-01") }),
          objective("d", { displayOrder: 3, health: "at_risk", healthRationale: "Supplier", healthAssessedAt: day("2026-09-02") }),
        ],
      },
      NOW,
    );
    expect(view.outcomes.map((o) => o.id)).toEqual(["a", "b", "d", "c"]);
    const [a, b, d] = view.outcomes;
    expect(a).toMatchObject({ health: "on_track", assessmentAgeDays: 31, stale: true });
    expect(d).toMatchObject({ assessmentAgeDays: 30, stale: false });
    expect(b).toMatchObject({ health: "not_assessed", stale: false, nextMilestone: null, trend: "no_history" });
    expect(view.changes).toBeNull();
    expect(view.narrative).toBeNull();
  });

  it("ranks leadership attention by tier, then date, caps it at three and counts the rest", () => {
    const input: OverviewInput = {
      ...empty,
      objectives: [
        objective("o1", { displayOrder: 1, health: "on_track", healthRationale: "x", healthAssessedAt: day("2026-09-30") }),
        objective("o2", { displayOrder: 2, health: "blocked", healthRationale: "y", healthAssessedAt: day("2026-09-30") }),
      ],
      milestones: [
        milestone("m-blocked", "o2", { forecastDate: day("2026-11-16") }),
        milestone("m-overdue", "o1", { baselineDate: day("2026-09-20") }),
        milestone("m-soon", "o2", { baselineDate: day("2026-10-12"), confidence: "committed" }),
        milestone("m-far", "o2", { baselineDate: day("2027-03-01") }),
      ],
      milestoneBlockers: [{ milestoneId: "m-blocked", taskId: "t1", taskTitle: "Aged domes", owner: "Ops", waitingFor: "Supplier" }],
      decisions: [
        { id: "d-later", title: "Pick partner", decider: "CEO", dueDate: day("2026-10-20"), objectiveId: "o2", recommendation: "Duke", impactOfDelay: "Study slips" },
        { id: "d-overdue", title: "Approve budget", decider: "CEO", dueDate: day("2026-09-28"), objectiveId: null, recommendation: null, impactOfDelay: null },
        { id: "d-far", title: "Later call", decider: "CEO", dueDate: day("2026-12-31"), objectiveId: null, recommendation: null, impactOfDelay: null },
        { id: "d-undated", title: "Someday", decider: "CEO", dueDate: null, objectiveId: null, recommendation: null, impactOfDelay: null },
      ],
      snapshot: {
        publishedAt: day("2026-09-01"),
        periodStart: day("2026-08-01"),
        periodEnd: day("2026-08-31"),
        narrative: "Last month.",
        summary: {
          objectives: [
            { id: "o1", title: "Outcome o1", health: "on_track" },
            { id: "o2", title: "Outcome o2", health: "at_risk" },
          ],
          milestones: [{ id: "m-soon", title: "Milestone m-soon", date: "2026-10-05", state: "planned" }],
        },
      },
    };
    const view = computeOverview(input, NOW);
    expect(view.attention.map((i) => `${i.kind}:${i.link.id}`)).toEqual(["decision:d-overdue", "decision:d-later", "blocker:t1"]);
    // Also queued: o2 worsened, o1's "on track" contradicted by an overdue
    // milestone, and two milestones due within 30 days (m-overdue, m-soon).
    expect(view.attentionTotal).toBe(7);
    expect(view.attention[0]).toMatchObject({ detail: "Overdue by 4 days", recommendation: null });
    expect(view.attention[1]).toMatchObject({ decider: "CEO", recommendation: "Duke", impactOfDelay: "Study slips", daysAway: 18 });

    const all = computeOverview(input, NOW);
    expect(all.outcomes[0]).toMatchObject({ assessmentMayBeOutdated: true });
    expect(all.outcomes[0].signals[0]).toContain("past its date");
    expect(all.outcomes[1].nextMilestone).toMatchObject({ id: "m-soon", daysAway: 10, confidence: "committed" });
    expect(all.changes).toEqual(
      expect.arrayContaining([
        { kind: "health", title: "Outcome o2", before: "At risk", after: "Blocked", objectiveId: "o2" },
        { kind: "milestone_date", title: "Milestone m-soon", before: "2026-10-05", after: "2026-10-12", objectiveId: "o2" },
      ]),
    );
    expect(all.narrative).toBe("Last month.");
    expect(all.period).toEqual({ publishedAt: "2026-09-01T00:00:00.000Z", periodStart: "2026-08-01", periodEnd: "2026-08-31" });

    // Same inputs in a different order rank identically.
    const shuffled = computeOverview(
      { ...input, decisions: [...input.decisions].reverse(), milestones: [...input.milestones].reverse(), objectives: [...input.objectives].reverse() },
      NOW,
    );
    expect(shuffled.attention).toEqual(view.attention);
    expect(shuffled.outcomes.map((o) => o.id)).toEqual(view.outcomes.map((o) => o.id));
  });

  it("builds the roadmap with slips and an unscheduled group, and reads trend from assessment history", () => {
    const view = computeOverview(
      {
        ...empty,
        objectives: [objective("o1", { health: "at_risk", healthRationale: "r", healthAssessedAt: day("2026-09-30") })],
        history: [
          { objectiveId: "o1", health: "on_track", assessedAt: day("2026-08-01") },
          { objectiveId: "o1", health: "not_assessed", assessedAt: day("2026-08-15") },
          { objectiveId: "o1", health: "at_risk", assessedAt: day("2026-09-30") },
        ],
        milestones: [
          milestone("slipped", "o1", { baselineDate: day("2026-12-01"), forecastDate: day("2027-01-12") }),
          milestone("done", "o1", { baselineDate: day("2026-08-01"), actualDate: day("2026-08-03"), state: "achieved" }),
          milestone("undated", "o1"),
          milestone("dropped", "o1", { baselineDate: day("2026-11-01"), state: "dropped" }),
          milestone("elsewhere", "unsorted-objective", { baselineDate: day("2026-11-01") }),
        ],
      },
      NOW,
    );
    expect(view.outcomes[0]).toMatchObject({ trend: "worsening", undatedMilestones: 1, nextMilestone: { id: "slipped", date: "2027-01-12" } });
    expect(view.outcomes[0].signals).toEqual(['Milestone "Milestone slipped" has slipped 42 days past its baseline']);
    expect(view.roadmap.scheduled.map((m) => [m.id, m.date, m.slipDays])).toEqual([
      ["done", "2026-08-03", null],
      ["slipped", "2027-01-12", 42],
    ]);
    expect(view.roadmap.unscheduled.map((m) => m.id)).toEqual(["undated"]);
  });

  it("puts escalated risks first, then the soonest affected milestone", () => {
    const risk = (id: string, over: Partial<OverviewInput["risks"][number]>) => ({
      id,
      objectiveId: "o1",
      milestoneId: null,
      title: id,
      impact: null,
      mitigation: null,
      owner: null,
      escalation: "watching" as const,
      nextReviewAt: null,
      ...over,
    });
    const view = computeOverview(
      {
        ...empty,
        objectives: [objective("o1")],
        milestones: [milestone("near", "o1", { baselineDate: day("2026-10-20") }), milestone("far", "o1", { baselineDate: day("2027-02-01") })],
        risks: [
          risk("watch-far", { milestoneId: "far" }),
          risk("escalated", { escalation: "decision_needed" }),
          risk("watch-near", { milestoneId: "near" }),
          risk("watch-none", {}),
          risk("other-org-objective", { objectiveId: "gone" }),
        ],
      },
      NOW,
    );
    expect(view.topRisks.map((r) => r.id)).toEqual(["escalated", "watch-near", "watch-far"]);
    expect(view.topRisks[1].milestoneTitle).toBe("Milestone near");
    expect(view.openRiskTotal).toBe(4);
    expect(view.outcomes[0].openRisks).toBe(4);
  });
});

describe("GET /api/overview and PUT /api/objectives/:id/health", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function cookie(f: Awaited<ReturnType<typeof createFixtureOrg>>, role: "admin" | "member") {
    return { [SESSION_COOKIE_NAME]: await signSession({ userId: f.user.id, organizationId: f.org.id, email: f.user.email, role }) };
  }

  it("shows only this organization's outcomes, skips Unsorted, and hides leadership-only decisions from members", async () => {
    const mine = await createFixtureOrg(db, { domain: "overview-mine.test", role: "member" });
    const theirs = await createFixtureOrg(db, { domain: "overview-theirs.test" });
    await db.insert(objectives).values({ organizationId: mine.org.id, title: "Unsorted / Needs Triage" });
    await db.insert(decisions).values([
      { organizationId: mine.org.id, title: "Team call", decider: "CEO", dueDate: new Date(Date.now() + 5 * 86400000), objectiveId: mine.objective.id },
      { organizationId: mine.org.id, title: "Board-only call", decider: "Board", dueDate: new Date(Date.now() + 6 * 86400000), visibility: "leadership" },
      { organizationId: theirs.org.id, title: "Their call", decider: "CEO", dueDate: new Date(Date.now() + 5 * 86400000) },
    ]);
    const [m] = await db.insert(milestones).values({ organizationId: mine.org.id, objectiveId: mine.objective.id, title: "Verification", forecastDate: new Date(Date.now() + 40 * 86400000) }).returning();
    const [blocked] = await db.insert(tasks).values({ organizationId: mine.org.id, projectId: mine.project.id, title: "Aged domes", status: "blocked" }).returning();
    const [hiddenBlocked] = await db
      .insert(tasks)
      .values({ organizationId: mine.org.id, projectId: mine.project.id, title: "Restricted blocker", status: "blocked", visibility: "restricted" })
      .returning();
    await db.insert(milestoneLinks).values([
      { organizationId: mine.org.id, milestoneId: m.id, entityType: "task", entityId: blocked.id },
      { organizationId: mine.org.id, milestoneId: m.id, entityType: "task", entityId: hiddenBlocked.id },
    ]);
    await db.insert(risks).values({ organizationId: mine.org.id, objectiveId: mine.objective.id, milestoneId: m.id, title: "Single supplier", escalation: "decision_needed" });
    await db.insert(reportingSnapshots).values({
      organizationId: mine.org.id,
      periodStart: new Date("2026-08-01"),
      periodEnd: new Date("2026-08-31"),
      narrative: "Published summary.",
      summary: { objectives: [], milestones: [] },
    });

    const app = await buildApp();
    const asMember = (await app.inject({ method: "GET", url: "/api/overview", cookies: await cookie(mine, "member") })).json();
    // The role is re-checked against the database on every request.
    await db.update(authorizedUsers).set({ role: "admin" }).where(eq(authorizedUsers.id, mine.authorization.id));
    const asAdmin = (await app.inject({ method: "GET", url: "/api/overview", cookies: await cookie(mine, "admin") })).json();
    await app.close();

    expect(asMember.outcomes.map((o: { id: string }) => o.id)).toEqual([mine.objective.id]);
    expect(asMember.attention.map((i: { title: string }) => i.title)).toEqual(["Team call", "Blocked: Aged domes"]);
    expect(asAdmin.attention.slice(0, 2).map((i: { title: string }) => i.title)).toEqual(["Team call", "Board-only call"]);
    expect(asAdmin.attentionTotal).toBe(4);
    expect(asMember.attentionTotal).toBe(2);
    expect(asMember.topRisks[0]).toMatchObject({ title: "Single supplier", milestoneTitle: "Verification" });
    expect(asMember.narrative).toBe("Published summary.");
    expect(asMember.changes).toEqual([]);
    expect(asMember.outcomes[0]).toMatchObject({ decisionsNeeded: 1, openRisks: 1, nextMilestone: { title: "Verification" } });
  });

  it("records a health assessment with its reason and history, and refuses one without a reason or from another organization", async () => {
    const mine = await createFixtureOrg(db, { domain: "health-mine.test" });
    const theirs = await createFixtureOrg(db, { domain: "health-theirs.test" });
    const app = await buildApp();
    const url = `/api/objectives/${mine.objective.id}/health`;
    const noReason = await app.inject({ method: "PUT", url, cookies: await cookie(mine, "member"), payload: { health: "at_risk" } });
    const badValue = await app.inject({ method: "PUT", url, cookies: await cookie(mine, "member"), payload: { health: "green", rationale: "x" } });
    const foreign = await app.inject({ method: "PUT", url, cookies: await cookie(theirs, "admin"), payload: { health: "blocked", rationale: "x" } });
    const ok = await app.inject({ method: "PUT", url, cookies: await cookie(mine, "member"), payload: { health: "at_risk", rationale: "Supplier slipped", reviewBy: "2026-11-01" } });
    const overview = (await app.inject({ method: "GET", url: "/api/overview", cookies: await cookie(mine, "member") })).json();
    await app.close();

    expect([noReason.statusCode, badValue.statusCode, foreign.statusCode, ok.statusCode]).toEqual([400, 400, 404, 200]);
    expect(ok.json().objective).toMatchObject({ health: "at_risk", healthRationale: "Supplier slipped" });
    const history = await db.select().from(objectiveHealthHistory).where(eq(objectiveHealthHistory.objectiveId, mine.objective.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ health: "at_risk", rationale: "Supplier slipped", source: "person" });
    expect(history[0].reviewBy?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(overview.outcomes[0]).toMatchObject({ health: "at_risk", healthRationale: "Supplier slipped", stale: false, assessmentAgeDays: 0 });
  });
});
