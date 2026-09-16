import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, initiatives, objectives, projects, tasks } from "../db/schema.js";
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

describe("GET /api/search", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/search?q=widget" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("returns all-empty results for a query below the minimum length instead of scanning", async () => {
    const fixture = await createFixtureOrg(db, { domain: "search-too-short.test" });
    const response = await getAsUser(fixture, "/api/search?q=w");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ objectives: [], initiatives: [], projects: [], tasks: [], decisions: [] });
  });

  it("returns all-empty results when q is omitted entirely", async () => {
    const fixture = await createFixtureOrg(db, { domain: "search-missing-q.test" });
    const response = await getAsUser(fixture, "/api/search");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ objectives: [], initiatives: [], projects: [], tasks: [], decisions: [] });
  });

  it("matches an objective by a case-insensitive partial title match", async () => {
    const fixture = await createFixtureOrg(db, { domain: "search-objective.test" });
    const [objective] = await db
      .insert(objectives)
      .values({ organizationId: fixture.org.id, title: "Reduce Sensor Board Defect Rate" })
      .returning();

    const response = await getAsUser(fixture, "/api/search?q=sensor board");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { objectives: Array<{ id: string }> };
    expect(body.objectives.map((o) => o.id)).toEqual([objective.id]);
  });

  it("matches a task by its latestUpdate content and includes its parent chain", async () => {
    const fixture = await createFixtureOrg(db, { domain: "search-task.test" });
    const [task] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Unrelated title",
        latestUpdate: "Vendor confirmed the firmware patch ships Friday",
        owner: "Sean",
      })
      .returning();

    const response = await getAsUser(fixture, "/api/search?q=firmware patch");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      tasks: Array<{ id: string; project: { id: string }; initiative: { id: string }; objective: { id: string } }>;
    };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe(task.id);
    expect(body.tasks[0].project.id).toBe(fixture.project.id);
    expect(body.tasks[0].initiative.id).toBe(fixture.initiative.id);
    expect(body.tasks[0].objective.id).toBe(fixture.objective.id);
  });

  it("matches a decision by title and an initiative by title", async () => {
    const fixture = await createFixtureOrg(db, { domain: "search-decision-initiative.test" });
    const [decision] = await db
      .insert(decisions)
      .values({ organizationId: fixture.org.id, title: "Approve vendor switch for sensor boards", decider: "CEO" })
      .returning();
    const [initiative] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Vendor qualification" })
      .returning();

    const response = await getAsUser(fixture, "/api/search?q=vendor");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { decisions: Array<{ id: string }>; initiatives: Array<{ id: string }> };
    expect(body.decisions.map((d) => d.id)).toEqual([decision.id]);
    expect(body.initiatives.map((i) => i.id)).toEqual([initiative.id]);
  });

  it("matches a project by title, scoped through its own org-joined initiative", async () => {
    const fixture = await createFixtureOrg(db, { domain: "search-project.test" });
    const [project] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Packaging redesign" })
      .returning();

    const response = await getAsUser(fixture, "/api/search?q=packaging");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { projects: Array<{ id: string; initiative: { id: string } }> };
    expect(body.projects.map((p) => p.id)).toEqual([project.id]);
    expect(body.projects[0].initiative.id).toBe(fixture.initiative.id);
  });

  it("never leaks another organization's matches", async () => {
    const orgA = await createFixtureOrg(db, { domain: "search-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "search-org-b.test" });

    await db.insert(objectives).values({ organizationId: orgB.org.id, title: "Shared keyword objective" });

    const response = await getAsUser(orgA, "/api/search?q=shared keyword");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { objectives: unknown[] };
    expect(body.objectives).toEqual([]);
  });

  it("caps results per type rather than returning every match", async () => {
    const fixture = await createFixtureOrg(db, { domain: "search-cap.test" });
    for (let i = 0; i < 10; i++) {
      await db.insert(objectives).values({ organizationId: fixture.org.id, title: `Capped objective ${i}` });
    }

    const response = await getAsUser(fixture, "/api/search?q=capped");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { objectives: unknown[] };
    expect(body.objectives).toHaveLength(8);
  });

  it("returns all-empty results for a query that matches nothing", async () => {
    const fixture = await createFixtureOrg(db, { domain: "search-no-noise.test" });
    const response = await getAsUser(fixture, "/api/search?q=zzz-no-such-term");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ objectives: [], initiatives: [], projects: [], tasks: [], decisions: [] });
  });
});
