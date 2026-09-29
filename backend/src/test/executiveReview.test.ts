import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, entityRelationships, objectives, sources, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { buildExecutiveReview, buildExecutiveReviewData, renderExecutiveReviewText, scoreAttention } from "../reports/executiveReview.js";
import { createReviewLink } from "../reports/reviewLinks.js";
import { generateIntegrationToken, revokeIntegrationToken } from "../integrations/manage.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-25T12:00:00Z");

async function cookieFor(fixture: Fixture) {
  return {
    [SESSION_COOKIE_NAME]: await signSession({
      userId: fixture.user.id,
      organizationId: fixture.org.id,
      email: fixture.user.email,
      role: fixture.authorization.role,
    }),
  };
}

async function sourceDated(fixture: Fixture, receivedAt: Date) {
  const [source] = await db
    .insert(sources)
    .values({ organizationId: fixture.org.id, type: "circleback", externalId: randomUUID(), receivedAt, rawBody: "x" })
    .returning();
  return source;
}

// The section a line falls under -- so assertions check where something
// appears, not just that it appears somewhere in the report.
function section(report: string, heading: string): string {
  const start = report.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = report.slice(start + heading.length).search(/\n\d\. [A-Z]/);
  return next === -1 ? report.slice(start) : report.slice(start, start + heading.length + next);
}

describe("executive review", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("leads with 'This week', then the sections in order, with raw counts last", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-sections.test" });
    const report = await buildExecutiveReview(fixture.org.id, "admin", NOW);

    expect(report).toContain("Generated: 2026-09-25 12:00 UTC");
    const headings = [
      "THIS WEEK",
      "1. DECISIONS NEEDED",
      "2. DEADLINE PASSED",
      "3. RISKS & BLOCKERS",
      "4. OPERATING ACTIONS",
      "5. NEEDS DISPOSITION",
      "6. RECENT DEVELOPMENTS",
      "7. AWAITING REVIEW IN PULSE",
      "8. FULL OPEN-TASK INVENTORY",
      "Reference counts:",
    ];
    const positions = headings.map((h) => report.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(report).toContain("Pulse doesn't record due dates on tasks");
  });

  it("files an old, unsupported record under needs disposition, not as a priority or a risk", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-disposition.test" });
    await db.update(objectives).set({ priority: "critical" }).where(eq(objectives.id, fixture.objective.id));
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Ancient active task", status: "active", nextAction: "Do it", updatedAt: new Date(NOW.getTime() - 120 * DAY) },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Long-blocked task", status: "blocked", updatedAt: new Date(NOW.getTime() - 100 * DAY) },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Freshly blocked task", status: "blocked", updatedAt: new Date(NOW.getTime() - 5 * DAY) },
    ]);

    const data = await buildExecutiveReviewData(fixture.org.id, "admin", NOW);
    expect(data.needsDisposition.map((t) => t.title)).toEqual(["Ancient active task", "Long-blocked task"]);
    expect(data.risks.map((t) => t.title)).toEqual(["Freshly blocked task"]);
    expect(data.operatingActions).toEqual([]);
    expect(data.headline.some((h) => h.startsWith("2 old records need disposition"))).toBe(true);

    const disposition = section(renderExecutiveReviewText(data), "5. NEEDS DISPOSITION");
    expect(disposition).toContain("Ancient active task (Test project) — last evidence");
    expect(disposition).toContain("120 days ago");
  });

  it("moves an open decision past its due date to 'deadline passed' instead of treating it as upcoming", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-deadline.test" });
    await db.insert(decisions).values([
      { organizationId: fixture.org.id, title: "Late call", decider: "CEO", dueDate: new Date(NOW.getTime() - 3 * DAY), whyItMatters: "Deadline passed." },
      { organizationId: fixture.org.id, title: "Upcoming call", decider: "Board", dueDate: new Date(NOW.getTime() + 10 * DAY) },
      { organizationId: fixture.org.id, title: "Open-ended call", decider: "Board" },
      { organizationId: fixture.org.id, title: "Settled call", decider: "CEO", status: "decided" },
    ]);
    const data = await buildExecutiveReviewData(fixture.org.id, "admin", NOW);

    expect(data.deadlinePassed.map((d) => d.title)).toEqual(["Late call"]);
    expect(data.deadlinePassed[0].daysOverdue).toBe(3);
    expect(data.decisionsNeeded.map((d) => d.title)).toEqual(["Upcoming call", "Open-ended call"]);
    expect(data.headline[0]).toBe("2 decisions need a call");
    expect(data.headline[1]).toContain("1 decision is past deadline with no recorded outcome");

    const report = renderExecutiveReviewText(data);
    expect(section(report, "2. DEADLINE PASSED")).toContain("3 days past due with no recorded outcome.");
    expect(section(report, "1. DECISIONS NEEDED")).not.toContain("Late call");
    expect(section(report, "1. DECISIONS NEEDED")).toContain("no due date recorded");
    expect(report).not.toContain("Settled call");
  });

  it("ranks operating actions by attention, and shows a blocked task's decision under risks", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-ranking.test" });
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Vague task", status: "active", updatedAt: new Date(NOW.getTime() - 40 * DAY) },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Clear task", status: "active", nextAction: "Call vendor", owner: "Karen", updatedAt: new Date(NOW.getTime() - 2 * DAY) },
    ]);
    const [blocked] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Ship harness", status: "blocked", updatedAt: new Date(NOW.getTime() - 12 * DAY) })
      .returning();
    await db.insert(decisions).values({ organizationId: fixture.org.id, title: "Pick a vendor", decider: "CEO", relatedTaskId: blocked.id });

    const data = await buildExecutiveReviewData(fixture.org.id, "admin", NOW);
    expect(data.operatingActions.map((t) => t.title)).toEqual(["Clear task", "Vague task"]);
    expect(data.operatingActions[1].attentionReasons).toEqual(["no next action recorded", "no new evidence in 40 days"]);
    expect(data.risks[0]).toMatchObject({ title: "Ship harness", waitingOnDecision: "Pick a vendor", daysSinceEvidence: 12 });

    const risks = section(renderExecutiveReviewText(data), "3. RISKS & BLOCKERS");
    expect(risks).toContain("[BLOCKED] Ship harness");
    expect(risks).toContain("Waiting on decision: Pick a vendor");
  });

  it("lists every open task in the inventory and leaves out finished ones", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-inventory.test" });
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Calibrate rig", status: "active", owner: "Karen", nextAction: "Call vendor" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Old finished work", status: "completed" },
    ]);
    const report = await buildExecutiveReview(fixture.org.id, "admin", NOW);

    const inventory = section(report, "8. FULL OPEN-TASK INVENTORY");
    expect(inventory).toContain("Test objective [medium priority] › Test initiative › Test project");
    expect(inventory).toContain("Calibrate rig");
    expect(inventory).toContain("Owner: Karen");
    expect(inventory).toContain("Next: Call vendor");
    expect(report).not.toContain("Old finished work");
  });

  it("counts a development as recent by when its evidence is dated, not when it was approved", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-recent.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Needle testing", status: "active" })
      .returning();
    const fresh = await sourceDated(fixture, new Date(NOW.getTime() - 3 * DAY));
    const ancient = await sourceDated(fixture, new Date("2019-05-22T00:00:00Z"));
    await db.insert(suggestions).values([
      {
        organizationId: fixture.org.id, sourceId: fresh.id, targetType: "task", targetId: task.id, changeType: "operational_update",
        proposedDiff: { latestUpdate: "18G passed the leak test" }, reasoning: "x", confidence: 0.9, status: "approved", reviewedAt: NOW,
      },
      {
        organizationId: fixture.org.id, sourceId: ancient.id, targetType: "task", targetId: task.id, changeType: "operational_update",
        proposedDiff: { latestUpdate: "Old 2019 note" }, reasoning: "x", confidence: 0.9, status: "approved", reviewedAt: NOW,
      },
    ]);

    const recent = section(await buildExecutiveReview(fixture.org.id, "admin", NOW), "6. RECENT DEVELOPMENTS");
    expect(recent).toContain("Sep 22, 2026 · Needle testing (from meeting)");
    expect(recent).toContain("latestUpdate: 18G passed the leak test");
    expect(recent).not.toContain("Old 2019 note");
  });

  it("describes a recent relationship in words, without repeating its raw fields", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-recent-relationship.test" });
    const [a] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Needle testing", status: "active" }).returning();
    const [b] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Choose needle size", status: "active" }).returning();
    const fresh = await sourceDated(fixture, new Date(NOW.getTime() - DAY));
    await db.insert(suggestions).values({
      organizationId: fixture.org.id, sourceId: fresh.id, targetType: "relationship", targetId: null, changeType: "relationship",
      proposedDiff: { fromType: "task", fromId: a.id, toType: "task", toId: b.id, relationType: "informs" },
      reasoning: "x", confidence: 0.9, status: "approved", reviewedAt: NOW,
    });
    const recent = section(await buildExecutiveReview(fixture.org.id, "admin", NOW), "6. RECENT DEVELOPMENTS");
    expect(recent).toContain("Needle testing informs Choose needle size (from meeting)");
    expect(recent).not.toContain("fromType");
  });

  it("names what each pending suggestion is about, with its confidence", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-review.test" });
    await db.insert(suggestions).values({
      organizationId: fixture.org.id, sourceId: fixture.source.id, targetType: "task", targetId: null, changeType: "new_task",
      proposedDiff: { projectId: fixture.project.id, title: "Call the vendor" }, reasoning: "Follow-up from the meeting.", confidence: 0.82,
    });
    const pending = section(await buildExecutiveReview(fixture.org.id, "admin", NOW), "7. AWAITING REVIEW IN PULSE");
    expect(pending).toContain("New task: Call the vendor — new task, 82% confidence");
    expect(pending).toContain("Why: Follow-up from the meeting.");
  });

  it("a member's review leaves out restricted tasks everywhere, including the review section; an admin's includes them", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-visibility.test" });
    const [secret] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Confidential term sheet", status: "active", visibility: "restricted" })
      .returning();
    await db.insert(suggestions).values({
      organizationId: fixture.org.id, sourceId: fixture.source.id, targetType: "task", targetId: secret.id, changeType: "operational_update",
      proposedDiff: { status: "blocked" }, reasoning: "Restricted detail.", confidence: 0.7,
    });

    const memberReport = await buildExecutiveReview(fixture.org.id, "member", NOW);
    const adminReport = await buildExecutiveReview(fixture.org.id, "admin", NOW);
    expect(memberReport).not.toContain("Confidential term sheet");
    expect(memberReport).not.toContain("Restricted detail.");
    expect(adminReport).toContain("Confidential term sheet");
  });
});

describe("scoreAttention", () => {
  const base = {
    objectivePriority: "critical",
    status: "blocked",
    waitingOnDecision: true,
    decisionDueSoonOrOverdue: false,
    hasNextAction: true,
    daysSinceEvidence: 5,
  };

  it("scores a fresh, blocked, critical, actionable item at the top", () => {
    expect(scoreAttention(base).score).toBe(100);
  });

  it("lets staleness lower a score without dominating it", () => {
    const fresh = scoreAttention({ ...base, status: "active", waitingOnDecision: false }).score;
    const month = scoreAttention({ ...base, status: "active", waitingOnDecision: false, daysSinceEvidence: 45 }).score;
    const quarter = scoreAttention({ ...base, status: "active", waitingOnDecision: false, daysSinceEvidence: 85 }).score;
    expect(month).toBeLessThan(fresh);
    expect(quarter).toBeLessThan(month);
    // Importance still outweighs freshness: a critical item going quiet
    // outranks a fresh low-priority one.
    const lowFresh = scoreAttention({ ...base, objectivePriority: "low", status: "active", waitingOnDecision: false }).score;
    expect(quarter).toBeGreaterThan(lowFresh);
  });

  it("explains its ranking in plain words", () => {
    const { reasons } = scoreAttention({ ...base, hasNextAction: false, decisionDueSoonOrOverdue: true, daysSinceEvidence: 50 });
    expect(reasons).toEqual([
      "critical-priority objective",
      "blocked",
      "blocking decision is due soon or overdue",
      "waiting on an open decision",
      "no next action recorded",
      "no new evidence in 50 days",
    ]);
  });
});
describe("GET /api/reports/executive-review", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("requires sign-in and returns the report text", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-route.test" });
    const app = await buildApp();
    const anonymous = await app.inject({ method: "GET", url: "/api/reports/executive-review" });
    const signedIn = await app.inject({ method: "GET", url: "/api/reports/executive-review", cookies: await cookieFor(fixture) });
    await app.close();

    expect(anonymous.statusCode).toBe(401);
    expect(signedIn.statusCode).toBe(200);
    expect((signedIn.json() as { text: string }).text).toContain("EXVADE PULSE — EXECUTIVE REVIEW");
  });
});

describe("private review links", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  function tokenOf(url: string): string {
    return new URL(url).searchParams.get("token")!;
  }

  it("an admin can create a link; opening it shows the live report with no-index headers", async () => {
    const fixture = await createFixtureOrg(db, { domain: "link-happy.test" });
    await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Calibrate rig", status: "active" });

    const app = await buildApp();
    const created = await app.inject({ method: "POST", url: "/api/reports/executive-review/link", cookies: await cookieFor(fixture) });
    expect(created.statusCode).toBe(201);
    const { url } = created.json() as { url: string; expiresAt: string };

    const opened = await app.inject({ method: "GET", url: `/api/public/review?token=${tokenOf(url)}` });
    await app.close();

    expect(opened.statusCode).toBe(200);
    expect(opened.headers["content-type"]).toContain("text/html");
    expect(opened.headers["x-robots-tag"]).toContain("noindex");
    expect(opened.headers["cache-control"]).toBe("no-store");
    expect(opened.body).toContain("Calibrate rig");
  });

  it("a non-admin can't create a link", async () => {
    const fixture = await createFixtureOrg(db, { domain: "link-member.test", role: "member" });
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/reports/executive-review/link", cookies: await cookieFor(fixture) });
    await app.close();
    expect(response.statusCode).toBe(403);
  });

  it("a link stops working when it expires, when the ChatGPT key is turned off or rotated, or if tampered with", async () => {
    const fixture = await createFixtureOrg(db, { domain: "link-dies.test" });
    const params = { organizationId: fixture.org.id, actorId: fixture.user.id };
    const expired = await createReviewLink(db, params, new Date(Date.now() - 8 * DAY));
    const live = await createReviewLink(db, params);

    const app = await buildApp();
    const open = (url: string) => app.inject({ method: "GET", url: `/api/public/review?token=${tokenOf(url)}` });

    expect((await open(expired.url)).statusCode).toBe(404);
    expect((await open(live.url)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/public/review?token=${tokenOf(live.url)}x` })).statusCode).toBe(404);

    await generateIntegrationToken(db, { ...params, type: "chatgpt" }); // rotate
    expect((await open(live.url)).statusCode).toBe(404);

    const afterRotate = await createReviewLink(db, params);
    expect((await open(afterRotate.url)).statusCode).toBe(200);
    await revokeIntegrationToken(db, { ...params, type: "chatgpt" }); // turn off
    const revoked = await open(afterRotate.url);
    await app.close();

    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).toContain("expired or was turned off");
  });

  it("robots.txt tells search engines to stay out", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/robots.txt" });
    await app.close();
    expect(response.body).toContain("Disallow: /");
  });
});

describe("executive review structure: links, freshness, roll-ups, focus", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function link(fixture: Fixture, from: [string, string], relationType: string, to: [string, string]) {
    await db.insert(entityRelationships).values({
      organizationId: fixture.org.id,
      fromType: from[0] as never,
      fromId: from[1],
      toType: to[0] as never,
      toId: to[1],
      relationType: relationType as never,
      createdBy: fixture.user.id,
    });
  }

  it("shows what a decision is waiting on, what informs it, and keeps coupled decisions adjacent", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-links.test" });
    const [pellet] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "White-pellet cell analysis", status: "active" })
      .returning();
    const [done] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Finished bench run", status: "completed" })
      .returning();
    const [gauge] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "16G/18G dome testing", status: "active" })
      .returning();
    const [a] = await db.insert(decisions).values({ organizationId: fixture.org.id, title: "A: Change needle gauge?", decider: "Don" }).returning();
    const [b] = await db.insert(decisions).values({ organizationId: fixture.org.id, title: "B: Unrelated call", decider: "CEO" }).returning();
    const [c] = await db.insert(decisions).values({ organizationId: fixture.org.id, title: "C: Enroll another EFS patient?", decider: "CEO" }).returning();

    await link(fixture, ["decision", a.id], "depends_on", ["task", pellet.id]);
    await link(fixture, ["task", done.id], "blocks", ["decision", a.id]); // finished -- shouldn't count
    await link(fixture, ["task", gauge.id], "informs", ["decision", a.id]);
    await link(fixture, ["decision", c.id], "coupled_with", ["decision", a.id]);

    const data = await buildExecutiveReviewData(fixture.org.id, "admin", NOW);
    const aView = data.decisionsNeeded.find((d) => d.id === a.id)!;
    expect(aView.waitingOn).toEqual(["White-pellet cell analysis"]);
    expect(aView.informedBy).toEqual(["16G/18G dome testing"]);
    expect(aView.coupledWith).toEqual(["C: Enroll another EFS patient?"]);
    const order = data.decisionsNeeded.map((d) => d.id);
    expect(Math.abs(order.indexOf(a.id) - order.indexOf(c.id))).toBe(1);
    expect(order).toContain(b.id);

    const text = section(renderExecutiveReviewText(data), "1. DECISIONS NEEDED");
    expect(text).toContain("Waiting on: White-pellet cell analysis");
    expect(text).toContain("Consider together with: C: Enroll another EFS patient?");
  });

  it("flags a stale next action even when the record itself is fresh", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-stale-next.test" });
    const oldAsOf = new Date(NOW.getTime() - 40 * DAY).toISOString();
    await db.insert(tasks).values([
      {
        organizationId: fixture.org.id, projectId: fixture.project.id, title: "Follow-on study scoping", status: "active",
        nextAction: "Wait for Sandra's proposal due May 8", updatedAt: new Date(NOW.getTime() - 2 * DAY),
        fieldEvidence: { nextAction: { asOf: oldAsOf, sourceId: null }, latestUpdate: { asOf: new Date(NOW.getTime() - 2 * DAY).toISOString(), sourceId: null } },
      },
      {
        organizationId: fixture.org.id, projectId: fixture.project.id, title: "Fresh one", status: "active",
        nextAction: "Call vendor", updatedAt: new Date(NOW.getTime() - 2 * DAY),
        fieldEvidence: { nextAction: { asOf: new Date(NOW.getTime() - 2 * DAY).toISOString(), sourceId: null } },
      },
    ]);
    await db.insert(decisions).values({
      organizationId: fixture.org.id, title: "Follow-on study", decider: "CEO", suggestedNextStep: "Wait for Sandra's proposal",
      updatedAt: new Date(NOW.getTime() - 60 * DAY),
    });

    const data = await buildExecutiveReviewData(fixture.org.id, "admin", NOW);
    const stale = data.operatingActions.find((t) => t.title === "Follow-on study scoping")!;
    expect(stale).toMatchObject({ nextActionStale: true, nextActionAgeDays: 40, daysSinceEvidence: 2 });
    expect(data.operatingActions.find((t) => t.title === "Fresh one")!.nextActionStale).toBe(false);
    expect(data.decisionsNeeded[0]).toMatchObject({ nextStepStale: true, nextStepAgeDays: 60 });
    expect(data.headline).toContain("2 next actions may be stale (no new evidence in 21+ days)");
    expect(renderExecutiveReviewText(data)).toContain("(may be stale: 40 days old)");
  });

  it("rolls tasks up into one line per workstream, leaving stale records out", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-rollup.test" });
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Blocked one", status: "blocked" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Active one", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Ancient", status: "active", updatedAt: new Date(NOW.getTime() - 200 * DAY) },
    ]);

    const data = await buildExecutiveReviewData(fixture.org.id, "admin", NOW);
    expect(data.workstreams).toHaveLength(1);
    expect(data.workstreams[0]).toMatchObject({
      project: "Test project",
      state: "needs attention",
      counts: { blocked: 1, needsAttention: 0, waiting: 0, active: 1 },
    });
    expect(data.workstreams[0].tasks.map((t) => t.title).sort()).toEqual(["Active one", "Blocked one"]);
    expect(section(renderExecutiveReviewText(data), "4. OPERATING ACTIONS")).toContain("Test project — needs attention (1 blocked, 1 active)");
  });

  it("puts past-deadline decisions first in Focus, then decisions due soon, then blockers", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-focus.test" });
    await db.insert(decisions).values([
      { organizationId: fixture.org.id, title: "Open-ended call", decider: "CEO" },
      { organizationId: fixture.org.id, title: "Due soon call", decider: "CEO", dueDate: new Date(NOW.getTime() + 3 * DAY) },
      { organizationId: fixture.org.id, title: "Late call", decider: "CEO", dueDate: new Date(NOW.getTime() - 3 * DAY) },
    ]);
    await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Stuck task", status: "blocked" });

    const data = await buildExecutiveReviewData(fixture.org.id, "admin", NOW);
    expect(data.focus.map((f) => [f.kind, f.title])).toEqual([
      ["deadline", "Late call"],
      ["decision", "Due soon call"],
      ["decision", "Open-ended call"],
      ["blocker", "Stuck task"],
    ]);
    expect(renderExecutiveReviewText(data)).toContain("FOCUS (most consequential first)\n1. Late call — 3 days past due");
  });
});
