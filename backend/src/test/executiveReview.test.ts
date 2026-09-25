import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, objectives, sources, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { buildExecutiveReview } from "../reports/executiveReview.js";
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

describe("buildExecutiveReview", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("has all six sections, a generated timestamp and an at-a-glance line", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-sections.test" });
    const report = await buildExecutiveReview(fixture.org.id, "admin", NOW);

    expect(report).toContain("Generated: 2026-09-25 12:00 UTC");
    expect(report).toContain("At a glance: 0 open tasks");
    for (const heading of [
      "1. CURRENT PRIORITIES",
      "2. OUTSTANDING DECISIONS",
      "3. BLOCKED, STUCK OR OVERDUE",
      "4. RECENT DEVELOPMENTS",
      "5. AWAITING REVIEW IN PULSE",
      "6. FULL OPEN-TASK INVENTORY",
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain("Pulse doesn't record due dates on tasks");
  });

  it("lists every open task in the inventory, leaves out finished ones, and puts high-priority work under priorities", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-inventory.test" });
    await db.update(objectives).set({ priority: "critical" }).where(eq(objectives.id, fixture.objective.id));
    const [lowObjective] = await db.insert(objectives).values({ organizationId: fixture.org.id, title: "Side quest", priority: "low" }).returning();
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Calibrate rig", status: "active", owner: "Karen", nextAction: "Call vendor" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Old finished work", status: "completed" },
    ]);
    const report = await buildExecutiveReview(fixture.org.id, "admin", NOW);

    const inventory = section(report, "6. FULL OPEN-TASK INVENTORY");
    expect(inventory).toContain("Calibrate rig");
    expect(inventory).toContain("Owner: Karen");
    expect(inventory).toContain("Next: Call vendor");
    expect(inventory).toContain(`${lowObjective.title} [low priority, active]`);
    expect(inventory).toContain("(no open tasks)");
    expect(report).not.toContain("Old finished work");
    expect(section(report, "1. CURRENT PRIORITIES")).toContain("Calibrate rig");
  });

  it("flags blocked work with how long it's been stuck and what decision it's waiting on, and stale active tasks", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-blocked.test" });
    const [blocked] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Ship harness", status: "blocked", updatedAt: new Date(NOW.getTime() - 12 * DAY) })
      .returning();
    await db.insert(tasks).values({
      organizationId: fixture.org.id,
      projectId: fixture.project.id,
      title: "Forgotten task",
      status: "active",
      updatedAt: new Date(NOW.getTime() - 45 * DAY),
    });
    await db.insert(decisions).values({ organizationId: fixture.org.id, title: "Pick a vendor", decider: "CEO", relatedTaskId: blocked.id });

    const stuck = section(await buildExecutiveReview(fixture.org.id, "admin", NOW), "3. BLOCKED, STUCK OR OVERDUE");
    expect(stuck).toContain("[BLOCKED] Ship harness");
    expect(stuck).toContain("No update in 12 days | Waiting on decision: Pick a vendor");
    expect(stuck).toContain("Forgotten task");
    expect(stuck).toContain("No update in 45 days");
  });

  it("shows decisions with due dates, marks overdue ones, and says when no due date is recorded", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-decisions.test" });
    await db.insert(decisions).values([
      { organizationId: fixture.org.id, title: "Late call", decider: "CEO", dueDate: new Date(NOW.getTime() - 3 * DAY), whyItMatters: "Deadline passed." },
      { organizationId: fixture.org.id, title: "Open-ended call", decider: "Board" },
      { organizationId: fixture.org.id, title: "Settled call", decider: "CEO", status: "decided" },
    ]);
    const report = await buildExecutiveReview(fixture.org.id, "admin", NOW);

    const decisionsSection = section(report, "2. OUTSTANDING DECISIONS");
    expect(decisionsSection).toContain("Late call");
    expect(decisionsSection).toContain("OVERDUE");
    expect(decisionsSection).toContain("Why it matters: Deadline passed.");
    expect(decisionsSection).toContain("no due date recorded");
    expect(report).not.toContain("Settled call");
    expect(section(report, "3. BLOCKED, STUCK OR OVERDUE")).toContain("Overdue decision: Late call");
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

    const recent = section(await buildExecutiveReview(fixture.org.id, "admin", NOW), "4. RECENT DEVELOPMENTS");
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
    const recent = section(await buildExecutiveReview(fixture.org.id, "admin", NOW), "4. RECENT DEVELOPMENTS");
    expect(recent).toContain("Needle testing informs Choose needle size (from meeting)");
    expect(recent).not.toContain("fromType");
  });

  it("names what each pending suggestion is about, with its confidence", async () => {
    const fixture = await createFixtureOrg(db, { domain: "exec-review.test" });
    await db.insert(suggestions).values({
      organizationId: fixture.org.id, sourceId: fixture.source.id, targetType: "task", targetId: null, changeType: "new_task",
      proposedDiff: { projectId: fixture.project.id, title: "Call the vendor" }, reasoning: "Follow-up from the meeting.", confidence: 0.82,
    });
    const pending = section(await buildExecutiveReview(fixture.org.id, "admin", NOW), "5. AWAITING REVIEW IN PULSE");
    expect(pending).toContain("New task: Call the vendor — new task, 82% confidence");
    expect(pending).toContain("Why: Follow-up from the meeting.");
  });

  it("a member's report leaves out restricted tasks everywhere, including the review section; an admin's includes them", async () => {
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
