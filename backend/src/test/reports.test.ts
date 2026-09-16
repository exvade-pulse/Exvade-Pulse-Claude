import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { initiatives, objectives, projects, sources, suggestions, tasks } from "../db/schema.js";
import { createDecision } from "../decisions/manage.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

async function tokenFor(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
  return signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: fixture.authorization.role,
  });
}

async function getAsUser(fixture: Awaited<ReturnType<typeof createFixtureOrg>>, url: string) {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) } });
  await app.close();
  return response;
}

// The target week throughout: Monday 2026-09-14 through Sunday 2026-09-20
// (UTC), matching computeWeekRange's Monday-start, half-open-range
// convention in reports.ts.
const WEEK_START = new Date("2026-09-14T00:00:00.000Z");
const WEEK_END_EXCLUSIVE = new Date("2026-09-21T00:00:00.000Z");

async function insertSourceAndApprovedSuggestion(
  organizationId: string,
  taskId: string,
  reviewedAt: Date,
  externalId = `ext-${randomUUID()}`,
) {
  const [source] = await db
    .insert(sources)
    .values({ organizationId, type: "gmail", externalId, receivedAt: reviewedAt, rawBody: "body" })
    .returning();
  await db.insert(suggestions).values({
    organizationId,
    sourceId: source.id,
    targetType: "task",
    targetId: taskId,
    changeType: "operational_update",
    proposedDiff: { latestUpdate: "did a thing" },
    reasoning: "test",
    confidence: 0.9,
    status: "approved",
    reviewedAt,
  });
  return source;
}

describe("GET /api/reports/weekly", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/reports/weekly?weekOf=2026-09-14" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("computes the Monday-Sunday week header from any weekOf date inside it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "reports-week-anchor.test" });
    // Wednesday, still inside the same target week as the Monday anchor.
    const response = await getAsUser(fixture, "/api/reports/weekly?weekOf=2026-09-16");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { weekStart: string; weekEnd: string };
    expect(body.weekStart).toBe("2026-09-14");
    expect(body.weekEnd).toBe("2026-09-20");
  });

  it("includes only tasks updated within the week under their objective's workstream, excludes tasks updated outside it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "reports-in-range.test" });

    const [inRange] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "In-range task",
        latestUpdate: "Shipped the thing",
        nextAction: "Tell the customer",
        owner: "Sean Meehan",
      })
      .returning();
    const [outOfRange] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Out-of-range task" })
      .returning();

    await db.update(tasks).set({ updatedAt: new Date("2026-09-15T12:00:00.000Z") }).where(eq(tasks.id, inRange.id));
    await db.update(tasks).set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") }).where(eq(tasks.id, outOfRange.id));

    const response = await getAsUser(fixture, "/api/reports/weekly?weekOf=2026-09-14");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      taskCount: number;
      workstreams: Array<{ objectiveId: string; objectiveTitle: string; tasks: Array<{ id: string; title: string }> }>;
    };

    expect(body.taskCount).toBe(1);
    expect(body.workstreams).toHaveLength(1);
    expect(body.workstreams[0].objectiveId).toBe(fixture.objective.id);
    const taskIds = body.workstreams[0].tasks.map((t) => t.id);
    expect(taskIds).toContain(inRange.id);
    expect(taskIds).not.toContain(outOfRange.id);
  });

  it("includes a task updated exactly at the week's start and excludes one updated exactly at the following week's start", async () => {
    const fixture = await createFixtureOrg(db, { domain: "reports-boundary.test" });

    const [atStart] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Exactly at week start" })
      .returning();
    const [atNextWeekStart] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Exactly at next week's start" })
      .returning();

    await db.update(tasks).set({ updatedAt: WEEK_START }).where(eq(tasks.id, atStart.id));
    await db.update(tasks).set({ updatedAt: WEEK_END_EXCLUSIVE }).where(eq(tasks.id, atNextWeekStart.id));

    const response = await getAsUser(fixture, "/api/reports/weekly?weekOf=2026-09-14");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { workstreams: Array<{ tasks: Array<{ id: string }> }> };
    const taskIds = body.workstreams.flatMap((ws) => ws.tasks.map((t) => t.id));

    expect(taskIds).toContain(atStart.id);
    expect(taskIds).not.toContain(atNextWeekStart.id);
  });

  it("lists blockers and open decisions regardless of date, and excludes decided decisions", async () => {
    const fixture = await createFixtureOrg(db, { domain: "reports-current-state.test" });

    const [blocked] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Blocked task",
        status: "blocked",
        owner: "Sean",
      })
      .returning();
    // Blocked long before the target week -- must still appear, since
    // blockers/decisions are current-state, not date-filtered.
    await db.update(tasks).set({ updatedAt: new Date("2020-01-01") }).where(eq(tasks.id, blocked.id));

    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs a call",
      decider: "CEO",
      dueDate: new Date("2020-01-01"),
    });

    const response = await getAsUser(fixture, "/api/reports/weekly?weekOf=2026-09-14");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      blockers: Array<{ id: string; title: string; owner: string | null }>;
      decisionsNeeded: Array<{ id: string; title: string }>;
    };

    expect(body.blockers.map((b) => b.id)).toEqual([blocked.id]);
    expect(body.blockers[0].owner).toBe("Sean");
    expect(body.decisionsNeeded.map((d) => d.id)).toEqual([decision.id]);
  });

  it("cites only sources backing an in-range task's approved suggestion, not every source in the org", async () => {
    const fixture = await createFixtureOrg(db, { domain: "reports-sources.test" });

    const [inRange] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "In-range, cited" })
      .returning();
    const [outOfRange] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Out-of-range, not cited" })
      .returning();

    await db.update(tasks).set({ updatedAt: new Date("2026-09-16T00:00:00.000Z") }).where(eq(tasks.id, inRange.id));
    await db.update(tasks).set({ updatedAt: new Date("2020-01-01") }).where(eq(tasks.id, outOfRange.id));

    const citedSource = await insertSourceAndApprovedSuggestion(
      fixture.org.id,
      inRange.id,
      new Date("2026-09-16T09:00:00.000Z"),
    );
    // Approved and reviewed within the week, but targets a task that itself
    // was NOT updated in-range -- must not leak into the appendix.
    await insertSourceAndApprovedSuggestion(fixture.org.id, outOfRange.id, new Date("2026-09-16T09:00:00.000Z"));

    const response = await getAsUser(fixture, "/api/reports/weekly?weekOf=2026-09-14");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sources: Array<{ id: string; type: string; externalId: string }>;
      workstreams: Array<{ tasks: Array<{ id: string; sourceCount: number }> }>;
    };

    expect(body.sources.map((s) => s.id)).toEqual([citedSource.id]);
    const inRangeTask = body.workstreams.flatMap((ws) => ws.tasks).find((t) => t.id === inRange.id);
    expect(inRangeTask?.sourceCount).toBe(1);
  });

  it("never leaks another organization's tasks, blockers, decisions, or sources into the report", async () => {
    const orgA = await createFixtureOrg(db, { domain: "reports-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "reports-org-b.test" });

    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B task", status: "blocked" })
      .returning();
    await db.update(tasks).set({ updatedAt: new Date("2026-09-16") }).where(eq(tasks.id, taskB.id));
    await createDecision(db, {
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      title: "Org B decision",
      decider: "CEO",
    });
    await insertSourceAndApprovedSuggestion(orgB.org.id, taskB.id, new Date("2026-09-16"));

    const response = await getAsUser(orgA, "/api/reports/weekly?weekOf=2026-09-14");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      blockers: unknown[];
      decisionsNeeded: unknown[];
      workstreams: unknown[];
      sources: unknown[];
      taskCount: number;
    };

    expect(body.blockers).toEqual([]);
    expect(body.decisionsNeeded).toEqual([]);
    expect(body.workstreams).toEqual([]);
    expect(body.sources).toEqual([]);
    expect(body.taskCount).toBe(0);
  });

  it("groups tasks from different objectives into separate workstream sections", async () => {
    const fixture = await createFixtureOrg(db, { domain: "reports-multi-workstream.test" });

    const [otherObjective] = await db
      .insert(objectives)
      .values({ organizationId: fixture.org.id, title: "A different objective" })
      .returning();
    const [otherInitiative] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: otherObjective.id, title: "Other initiative" })
      .returning();
    const [otherProject] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: otherInitiative.id, title: "Other project" })
      .returning();

    const [taskA] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task under objective A" })
      .returning();
    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: otherProject.id, title: "Task under objective B" })
      .returning();

    await db.update(tasks).set({ updatedAt: new Date("2026-09-16") }).where(eq(tasks.id, taskA.id));
    await db.update(tasks).set({ updatedAt: new Date("2026-09-17") }).where(eq(tasks.id, taskB.id));

    const response = await getAsUser(fixture, "/api/reports/weekly?weekOf=2026-09-14");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { workstreams: Array<{ objectiveId: string }> };

    const objectiveIds = body.workstreams.map((ws) => ws.objectiveId).sort();
    expect(objectiveIds).toEqual([fixture.objective.id, otherObjective.id].sort());
  });
});
