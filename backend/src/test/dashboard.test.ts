import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { initiatives, objectives, projects, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

const ZERO_TASK_COUNTS = {
  active: 0,
  waiting: 0,
  needs_attention: 0,
  completed: 0,
  superseded: 0,
  resolved: 0,
  blocked: 0,
};

describe("GET /api/dashboard/objectives", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await client.end();
  });

  async function getAsUser(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
    const app = await buildApp();
    const token = await signSession({
      userId: fixture.user.id,
      organizationId: fixture.org.id,
      email: fixture.user.email,
      role: fixture.authorization.role,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/objectives",
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    await app.close();
    return response;
  }

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/dashboard/objectives" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("an objective with no initiatives or tasks returns zeroed counts, not omitted", async () => {
    const fixture = await createFixtureOrg(db, { domain: "empty-objective.test" });
    // createFixtureOrg's own objective already has an initiative/project attached,
    // so add a second, bare objective to exercise the zero-rollup case.
    const [bareObjective] = await db
      .insert(objectives)
      .values({ organizationId: fixture.org.id, title: "Bare objective", priority: "low" })
      .returning();

    const response = await getAsUser(fixture);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { objectives: Array<Record<string, unknown>> };
    const row = body.objectives.find((o) => o.id === bareObjective.id);
    expect(row).toBeDefined();
    expect(row!.initiativeCount).toBe(0);
    expect(row!.taskCounts).toEqual(ZERO_TASK_COUNTS);
  });

  it("rolls up a realistic tree correctly: 2 active, 1 blocked, 1 completed across mixed initiatives", async () => {
    const fixture = await createFixtureOrg(db, { domain: "realistic-tree.test" });

    // fixture already has one initiative -> one project under fixture.objective.
    const [initiativeB] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Initiative B" })
      .returning();
    const [projectB] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: initiativeB.id, title: "Project B" })
      .returning();

    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T1", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T2", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T3", status: "blocked" },
      { organizationId: fixture.org.id, projectId: projectB.id, title: "T4", status: "completed" },
    ]);

    const response = await getAsUser(fixture);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { objectives: Array<Record<string, unknown>> };
    const row = body.objectives.find((o) => o.id === fixture.objective.id);
    expect(row).toBeDefined();
    expect(row!.initiativeCount).toBe(2);
    expect(row!.taskCounts).toEqual({
      ...ZERO_TASK_COUNTS,
      active: 2,
      blocked: 1,
      completed: 1,
    });
  });

  it("aggregates tasks nested under two different initiatives' projects into the same objective rollup", async () => {
    const fixture = await createFixtureOrg(db, { domain: "multi-initiative.test" });

    const [initiativeB] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Initiative B" })
      .returning();
    const [projectB] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: initiativeB.id, title: "Project B" })
      .returning();

    // One task under initiative A's project, one under initiative B's project --
    // both must land in the same objective's rollup, not just the first initiative's.
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Under A", status: "waiting" },
      { organizationId: fixture.org.id, projectId: projectB.id, title: "Under B", status: "waiting" },
    ]);

    const response = await getAsUser(fixture);
    const body = response.json() as { objectives: Array<Record<string, unknown>> };
    const row = body.objectives.find((o) => o.id === fixture.objective.id);
    expect(row!.taskCounts).toEqual({ ...ZERO_TASK_COUNTS, waiting: 2 });
  });

  it("returns owner: null for an objective with no owner set, and the real value once one is", async () => {
    const fixture = await createFixtureOrg(db, { domain: "owner-dashboard.test" });
    const [owned] = await db
      .insert(objectives)
      .values({ organizationId: fixture.org.id, title: "Owned objective", owner: "Sean Meehan" })
      .returning();

    const response = await getAsUser(fixture);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { objectives: Array<Record<string, unknown>> };

    const unowned = body.objectives.find((o) => o.id === fixture.objective.id);
    expect(unowned!.owner).toBeNull();

    const ownedRow = body.objectives.find((o) => o.id === owned.id);
    expect(ownedRow!.owner).toBe("Sean Meehan");
  });

  it("never returns an objective belonging to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "dash-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "dash-org-b.test" });

    const response = await getAsUser(orgA);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { objectives: Array<Record<string, unknown>> };
    const ids = body.objectives.map((o) => o.id);
    expect(ids).toContain(orgA.objective.id);
    expect(ids).not.toContain(orgB.objective.id);
  });
});
