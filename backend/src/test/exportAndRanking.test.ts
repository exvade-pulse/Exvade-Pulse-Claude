import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, decisions, initiatives, objectives, projects, sources, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { buildExecutiveReviewData } from "../reports/executiveReview.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;

async function as(f: Fixture, role: "admin" | "member") {
  await db.update(authorizedUsers).set({ role }).where(eq(authorizedUsers.id, f.authorization.id));
  return { [SESSION_COOKIE_NAME]: await signSession({ userId: f.user.id, organizationId: f.org.id, email: f.user.email, role }) };
}

describe("Export", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("gives an admin every record with ids, finished and merged ones included, but no email text", async () => {
    const f = await createFixtureOrg(db, { domain: "export.test" });
    const theirs = await createFixtureOrg(db, { domain: "export-other.test" });
    const [keep] = await db.insert(tasks).values({ organizationId: f.org.id, projectId: f.project.id, title: "Needle size testing, \"dome\"" }).returning();
    await db.insert(tasks).values([
      { organizationId: f.org.id, projectId: f.project.id, title: "Old copy", status: "superseded", supersededById: keep.id },
      { organizationId: f.org.id, projectId: f.project.id, title: "Done thing", status: "completed" },
      { organizationId: theirs.org.id, projectId: theirs.project.id, title: "Not ours" },
    ]);
    await db.insert(suggestions).values({ organizationId: f.org.id, sourceId: f.source.id, targetType: "task", targetId: keep.id, changeType: "operational_update", proposedDiff: { status: "blocked" }, reasoning: "x", confidence: 0.8 });

    const app = await buildApp();
    const member = await app.inject({ method: "GET", url: "/api/export", cookies: await as(f, "member") });
    const admin = await as(f, "admin");
    const json = await app.inject({ method: "GET", url: "/api/export", cookies: admin });
    const csv = await app.inject({ method: "GET", url: "/api/export?format=tasks.csv", cookies: admin });
    await app.close();

    expect(member.statusCode).toBe(403);
    const data = json.json();
    expect(json.headers["content-disposition"]).toMatch(/attachment; filename="pulse-export-\d{4}-\d{2}-\d{2}\.json"/);
    expect(data.tasks.map((t: { title: string }) => t.title).sort()).toEqual(["Done thing", "Needle size testing, \"dome\"", "Old copy"]);
    expect(data.tasks.find((t: { title: string }) => t.title === "Old copy")).toMatchObject({ status: "superseded", supersededById: keep.id, outcome: "Test objective", project: "Test project" });
    expect(data.pendingReviewCards).toHaveLength(1);
    expect(data.counts).toMatchObject({ tasks: 3, pendingReviewCards: 1, sources: 1 });
    expect(JSON.stringify(data)).not.toContain("fixture email body");
    expect(data.sources[0]).toEqual({ id: f.source.id, type: "gmail", externalId: expect.any(String), receivedAt: expect.any(String) });

    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("id,title,status,owner,outcome,initiative,project,nextAction,waitingFor,dueDate,dueDateType,latestUpdate,supersededById,updatedAt");
    expect(lines.some((l) => l.includes('"Needle size testing, ""dome"""'))).toBe(true);
    expect(lines).toHaveLength(4);
  });
});

describe("Operating Detail ranking", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("orders workstreams by the leadership outcome order, never by how many tasks they have", async () => {
    const f = await createFixtureOrg(db, { domain: "ranking.test" });
    // The fixture's outcome is second in order; a new one is first.
    await db.update(objectives).set({ title: "Reliable sampling", displayOrder: 2 }).where(eq(objectives.id, f.objective.id));
    const [first] = await db.insert(objectives).values({ organizationId: f.org.id, title: "Funding", displayOrder: 1 }).returning();
    const [ini] = await db.insert(initiatives).values({ organizationId: f.org.id, objectiveId: first.id, title: "Grants" }).returning();
    const [proj] = await db.insert(projects).values({ organizationId: f.org.id, initiativeId: ini.id, title: "Marcus report" }).returning();
    await db.insert(tasks).values({ organizationId: f.org.id, projectId: proj.id, title: "Reconcile report", status: "active" });
    // Lots of busy, even blocked, work under the second outcome.
    await db.insert(tasks).values(
      Array.from({ length: 12 }, (_, i) => ({ organizationId: f.org.id, projectId: f.project.id, title: `Busy task ${i}`, status: i < 3 ? ("blocked" as const) : ("active" as const) })),
    );
    const data = await buildExecutiveReviewData(f.org.id, "admin");
    expect(data.workstreams.map((w) => w.objective)).toEqual(["Funding", "Reliable sampling"]);
    expect(data.workstreams[0]).toMatchObject({ objectiveOrder: 1, project: "Marcus report" });
  });

  it("lists a decision's recommendation, cost of delay and outcome", async () => {
    const f = await createFixtureOrg(db, { domain: "decision-list.test" });
    await db.insert(decisions).values({ organizationId: f.org.id, title: "Pick partner", decider: "CEO", objectiveId: f.objective.id, recommendation: "Duke", impactOfDelay: "Slips a quarter" });
    await db.insert(sources).values({ organizationId: f.org.id, type: "manual", externalId: "x", receivedAt: new Date(), rawBody: "x" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/decisions", cookies: await as(f, "member") });
    await app.close();
    expect(res.json().decisions[0]).toMatchObject({ recommendation: "Duke", impactOfDelay: "Slips a quarter", outcomeTitle: "Test objective" });
  });
});
