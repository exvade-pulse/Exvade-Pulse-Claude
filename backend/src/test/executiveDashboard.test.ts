import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, projects, sources, suggestions, tasks } from "../db/schema.js";
import { buildExecutiveReviewData, renderExecutiveReviewText } from "../reports/executiveReview.js";
import { buildDashboard, type Viewer } from "../reports/dashboard.js";
import { createQuestion, linkToQuestion } from "../questions/manage.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;
const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

const sean = (fixture: Fixture, role: Viewer["role"] = "admin"): Viewer => ({ userId: fixture.user.id, name: "Sean Meehan", email: "sean@exvade.test", role });
const karen = (fixture: Fixture): Viewer => ({ userId: fixture.user.id, name: "Karen Smith", email: "karen@exvade.test", role: "member" });

async function approvedChange(fixture: Fixture, target: { type: "task" | "decision"; id: string }, diff: Record<string, unknown>, when: Date) {
  const [source] = await db
    .insert(sources)
    .values({ organizationId: fixture.org.id, type: "gmail", externalId: randomUUID(), receivedAt: when, rawBody: "x" })
    .returning();
  await db.insert(suggestions).values({
    organizationId: fixture.org.id,
    sourceId: source.id,
    targetType: target.type,
    targetId: target.id,
    changeType: "operational_update",
    proposedDiff: diff,
    reasoning: "r",
    confidence: 0.9,
    status: "approved",
    reviewedAt: when,
    reviewedBy: fixture.user.id,
  });
}

async function seed(fixture: Fixture) {
  const [pellet] = await db
    .insert(tasks)
    .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "White-pellet investigation", status: "needs_attention", owner: "Sean", nextAction: "Confirm collection technique" })
    .returning();
  const [dna] = await db
    .insert(tasks)
    .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Low-volume DNA/RNA testing", status: "blocked", owner: "Duke" })
    .returning();
  const [gauge] = await db
    .insert(decisions)
    .values({ organizationId: fixture.org.id, title: "Change needle gauge?", decider: "Sean", dueDate: daysFromNow(10), suggestedNextStep: "Compare 18G data" })
    .returning();
  const [old] = await db
    .insert(decisions)
    .values({ organizationId: fixture.org.id, title: "Old call", decider: "Karen", dueDate: daysFromNow(-5) })
    .returning();
  return { pellet, dna, gauge, old };
}

describe("executive dashboard", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("builds a priority from a strategic question with its next action, owner, key date and grouped records", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dash-priority.test" });
    const { pellet, dna, gauge } = await seed(fixture);
    const q = await createQuestion(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      objectiveId: fixture.objective.id,
      title: "Is the TMD reliably recovering useful biological material?",
      label: "Clinical Sampling / White Pellet",
      nextAction: "Confirm collection technique and begin minimum-volume cell confirmation.",
      owner: "Sean / Duke",
      keyDependency: "Sample availability and assay plan",
    });
    for (const [entityType, entityId] of [["task", pellet.id], ["task", dna.id], ["decision", gauge.id]] as const) {
      await linkToQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, entityType, entityId });
    }

    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    const dash = await buildDashboard(fixture.org.id, data, sean(fixture), null);
    const p = dash.priorities.find((x) => x.kind === "question")!;
    expect(p).toMatchObject({
      title: "Clinical Sampling / White Pellet",
      objective: "Is the TMD reliably recovering useful biological material?",
      state: "needs action",
      nextAction: "Confirm collection technique and begin minimum-volume cell confirmation.",
      nextActionIsMine: true,
      owner: "Sean / Duke",
      keyDependency: "Sample availability and assay plan",
      keyDate: { label: "Change needle gauge?" },
    });
    expect(p.details.work.map((w) => w.title).sort()).toEqual(["Low-volume DNA/RNA testing", "White-pellet investigation"]);
    expect(p.details.decisions.map((d) => d.title)).toEqual(["Change needle gauge?"]);

    const forKaren = await buildDashboard(fixture.org.id, data, karen(fixture), null);
    expect(forKaren.priorities.find((x) => x.kind === "question")!.nextActionIsMine).toBe(false);

    const text = renderExecutiveReviewText(data, dash);
    expect(text.indexOf("EXECUTIVE PRIORITIES")).toBeLessThan(text.indexOf("THIS WEEK"));
    expect(text).toContain("Next: Confirm collection technique and begin minimum-volume cell confirmation.");
  });

  it("with no strategic questions, reports setup as incomplete instead of promoting workstreams; never promotes Unsorted", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dash-fallback.test" });
    await seed(fixture);
    const [unsorted] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Unsorted / Needs Triage" })
      .returning();
    await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: unsorted.id, title: "Loose item", status: "needs_attention" });
    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    const dash = await buildDashboard(fixture.org.id, data, sean(fixture), null);
    expect(dash.strategySetupIncomplete).toBe(true);
    expect(dash.priorities).toEqual([]);
    expect(dash.unlinkedWorkstreams.map((w) => w.title)).toEqual([fixture.project.title]);
    expect(dash.unsortedTasks).toBe(1);
  });

  it("marks a next action as yours only when you are the one doing it, not because you own the priority", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dash-executor.test" });
    const [staining] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Stain analysis", status: "active", owner: "Vidya", nextAction: "Run the staining panel" })
      .returning();
    const q = await createQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, objectiveId: fixture.objective.id, title: "Bench?", owner: "Sean" });
    await linkToQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, entityType: "task", entityId: staining.id });
    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    const p = (await buildDashboard(fixture.org.id, data, sean(fixture), null)).priorities[0];
    expect(p).toMatchObject({ owner: "Sean", nextAction: "Run the staining panel", nextActionOwner: "Vidya", nextActionIsMine: false });
  });

  it("shows needs-me, real upcoming deadlines only, and what's waiting or blocked", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dash-lists.test" });
    const { gauge, old, dna, pellet } = await seed(fixture);
    const data = await buildExecutiveReviewData(fixture.org.id, "admin");

    const mine = await buildDashboard(fixture.org.id, data, sean(fixture), null);
    expect(mine.needsMe.map((i) => i.id)).toEqual(expect.arrayContaining([gauge.id, pellet.id]));
    expect(mine.needsMe.map((i) => i.id)).not.toContain(old.id);
    expect(mine.upcomingDeadlines.map((d) => d.id)).toEqual([gauge.id]);
    expect(mine.upcomingDeadlines[0].daysAway).toBe(10);
    expect(mine.waiting.map((w) => w.id)).toContain(dna.id);

    const hers = await buildDashboard(fixture.org.id, data, karen(fixture), null);
    expect(hers.needsMe.map((i) => i.id)).toEqual([old.id]);
    expect(hers.needsMe[0].detail).toContain("record what happened");
  });

  it("what changed: only meaningful changes since the last review, one per record, hiding restricted ones from members", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dash-changes.test" });
    const { pellet, dna, gauge } = await seed(fixture);
    const lastReview = daysFromNow(-3);
    await approvedChange(fixture, { type: "task", id: pellet.id }, { latestUpdate: "Needle now believed to be 21G, not 18G." }, daysFromNow(-1));
    await approvedChange(fixture, { type: "task", id: pellet.id }, { latestUpdate: "Older note." }, daysFromNow(-2));
    await approvedChange(fixture, { type: "task", id: dna.id }, { latestUpdate: "Before the last review." }, daysFromNow(-6));
    await approvedChange(fixture, { type: "decision", id: gauge.id }, { relevantContext: "16G dome testing underway." }, daysFromNow(-1));
    await db.update(decisions).set({ visibility: "leadership" });

    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    const admin = await buildDashboard(fixture.org.id, data, sean(fixture), lastReview);
    expect(admin.whatChanged.map((c) => c.text).sort()).toEqual(["16G dome testing underway.", "Needle now believed to be 21G, not 18G."]);
    expect(admin.whatChanged.find((c) => c.recordId === pellet.id)!.about).toBe("White-pellet investigation");

    const member = await buildDashboard(fixture.org.id, await buildExecutiveReviewData(fixture.org.id, "member"), sean(fixture, "member"), lastReview);
    expect(member.whatChanged.map((c) => c.text)).toEqual(["Needle now believed to be 21G, not 18G."]);
  });
});
