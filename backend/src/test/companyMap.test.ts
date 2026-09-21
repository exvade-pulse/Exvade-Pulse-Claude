import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { eq } from "drizzle-orm";
import { initiatives, objectives, projects, sources, suggestions, tasks } from "../db/schema.js";
import { createDecision, resolveDecision } from "../decisions/manage.js";
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

describe("GET /api/company-map", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/company-map" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("an org with zero objectives returns an empty tree, not an error", async () => {
    const fixture = await createFixtureOrg(db, { domain: "map-empty.test" });
    // createFixtureOrg always creates one objective (with an initiative and
    // project cascading from it) -- delete it to exercise the genuinely-empty
    // case; onDelete: "cascade" on initiatives/projects/tasks takes the rest
    // with it.
    await db.delete(objectives).where(eq(objectives.organizationId, fixture.org.id));

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/company-map",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { objectives: unknown[] };
    expect(body.objectives).toEqual([]);
  });

  // Real user-reported bug: a task's "Updated" date was showing when the
  // database row was last written to (i.e. when a historical document was
  // imported), not the real-world date of the information -- making a 2020
  // status meeting look like it happened today. The task itself is created
  // "today" (fixture default), but its real evidence comes from a source
  // dated 2020; the response must reflect the 2020 date, not the row's own
  // recent updatedAt.
  it("shows the real source date, not the DB row's own updatedAt, for a task built from a historical document", async () => {
    const fixture = await createFixtureOrg(db, { domain: "map-real-updated-date.test" });
    const historicalDate = new Date("2020-07-28T00:00:00.000Z");
    const [source] = await db
      .insert(sources)
      .values({ organizationId: fixture.org.id, type: "document", externalId: "2020-status-meeting", receivedAt: historicalDate })
      .returning();

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Animal study justification/rationale", status: "needs_attention" })
      .returning();
    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: source.id,
      targetType: "task",
      targetId: task.id,
      changeType: "new_task",
      proposedDiff: { title: "Animal study justification/rationale", status: "needs_attention" },
      reasoning: "test",
      confidence: 0.6,
      status: "approved",
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/company-map",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    const body = response.json() as {
      objectives: Array<{ initiatives: Array<{ projects: Array<{ tasks: Array<{ id: string; updatedAt: string }> }> }> }>;
    };
    const foundTask = body.objectives[0].initiatives[0].projects[0].tasks.find((t) => t.id === task.id);
    expect(foundTask?.updatedAt).toBe(historicalDate.toISOString());
    // Sanity check the fixture's own row really was written "now", not 2020
    // -- proving this assertion is actually exercising the override, not
    // coincidentally matching a row that happened to be old already.
    expect(new Date(task.updatedAt).getFullYear()).toBeGreaterThan(2020);
  });

  it("falls back to the row's own updatedAt when a task has no approved-suggestion history at all", async () => {
    const fixture = await createFixtureOrg(db, { domain: "map-real-updated-fallback.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Hand-created task", status: "active" })
      .returning();

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/company-map",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    const body = response.json() as {
      objectives: Array<{ initiatives: Array<{ projects: Array<{ tasks: Array<{ id: string; updatedAt: string }> }> }> }>;
    };
    const foundTask = body.objectives[0].initiatives[0].projects[0].tasks.find((t) => t.id === task.id);
    expect(foundTask?.updatedAt).toBe(task.updatedAt.toISOString());
  });

  it("returns the full nested tree for the caller's org, org-isolated from another org's data", async () => {
    const orgA = await createFixtureOrg(db, { domain: "map-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "map-org-b.test" });

    const [initiativeB] = await db
      .insert(initiatives)
      .values({ organizationId: orgA.org.id, objectiveId: orgA.objective.id, title: "Initiative B" })
      .returning();
    const [projectB] = await db
      .insert(projects)
      .values({ organizationId: orgA.org.id, initiativeId: initiativeB.id, title: "Project B" })
      .returning();

    await db.insert(tasks).values([
      {
        organizationId: orgA.org.id,
        projectId: orgA.project.id,
        title: "Task A1",
        status: "active",
        latestUpdate: "In progress",
        nextAction: "Keep going",
        owner: "Sean Meehan",
      },
      { organizationId: orgA.org.id, projectId: projectB.id, title: "Task B1", status: "blocked" },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/company-map",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      objectives: Array<{
        id: string;
        title: string;
        owner: string | null;
        initiatives: Array<{
          id: string;
          title: string;
          owner: string | null;
          projects: Array<{
            id: string;
            title: string;
            owner: string | null;
            tasks: Array<{ id: string; title: string; status: string; latestUpdate: string | null; owner: string | null }>;
          }>;
        }>;
      }>;
    };

    // Org isolation: only orgA's objective shows up.
    const objectiveIds = body.objectives.map((o) => o.id);
    expect(objectiveIds).toContain(orgA.objective.id);
    expect(objectiveIds).not.toContain(orgB.objective.id);

    const objective = body.objectives.find((o) => o.id === orgA.objective.id)!;
    expect(objective.owner).toBeNull();
    const initiativeIds = objective.initiatives.map((i) => i.id);
    expect(initiativeIds).toContain(orgA.initiative.id);
    expect(initiativeIds).toContain(initiativeB.id);

    const initiativeA = objective.initiatives.find((i) => i.id === orgA.initiative.id)!;
    expect(initiativeA.projects.map((p) => p.id)).toContain(orgA.project.id);
    const projectA = initiativeA.projects.find((p) => p.id === orgA.project.id)!;
    expect(projectA.tasks).toHaveLength(1);
    expect(projectA.tasks[0].title).toBe("Task A1");
    expect(projectA.tasks[0].latestUpdate).toBe("In progress");
    expect(projectA.tasks[0].owner).toBe("Sean Meehan");

    const initiativeBNode = objective.initiatives.find((i) => i.id === initiativeB.id)!;
    const projectBNode = initiativeBNode.projects.find((p) => p.id === projectB.id)!;
    expect(projectBNode.tasks).toHaveLength(1);
    expect(projectBNode.tasks[0].title).toBe("Task B1");
  });

  it("tags each task row with its approved-suggestion source count and any blocking open decision", async () => {
    const fixture = await createFixtureOrg(db, { domain: "map-tags.test" });

    const [citedTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Cited task", status: "active" })
      .returning();
    const [blockedTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Blocked task", status: "blocked" })
      .returning();
    const [plainTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Plain task", status: "active" })
      .returning();

    await db.insert(suggestions).values([
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: citedTask.id,
        changeType: "operational_update",
        proposedDiff: {},
        reasoning: "First",
        confidence: 0.8,
        status: "approved",
      },
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: citedTask.id,
        changeType: "operational_update",
        proposedDiff: {},
        reasoning: "Second",
        confidence: 0.8,
        status: "approved",
      },
      // A pending (not approved) suggestion on the same task must not count.
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: citedTask.id,
        changeType: "operational_update",
        proposedDiff: {},
        reasoning: "Still pending",
        confidence: 0.5,
        status: "pending",
      },
    ]);

    const blockingDecision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs a call before this can proceed",
      decider: "CEO",
      relatedTaskId: blockedTask.id,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/company-map",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      objectives: Array<{
        initiatives: Array<{
          projects: Array<{
            tasks: Array<{
              id: string;
              sourceCount: number;
              blockingDecision: { id: string; title: string } | null;
            }>;
          }>;
        }>;
      }>;
    };
    const allTasks = body.objectives.flatMap((o) => o.initiatives.flatMap((i) => i.projects.flatMap((p) => p.tasks)));

    const cited = allTasks.find((t) => t.id === citedTask.id)!;
    expect(cited.sourceCount).toBe(2);
    expect(cited.blockingDecision).toBeNull();

    const blocked = allTasks.find((t) => t.id === blockedTask.id)!;
    expect(blocked.sourceCount).toBe(0);
    expect(blocked.blockingDecision).toEqual({ id: blockingDecision.id, title: blockingDecision.title });

    const plain = allTasks.find((t) => t.id === plainTask.id)!;
    expect(plain.sourceCount).toBe(0);
    expect(plain.blockingDecision).toBeNull();
  });
});

describe("company map detail endpoints", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  describe("GET /api/objectives/:id", () => {
    it("returns full detail plus its initiatives, unauthenticated is 401", async () => {
      const app = await buildApp();
      const unauth = await app.inject({ method: "GET", url: `/api/objectives/${randomUUID()}` });
      expect(unauth.statusCode).toBe(401);

      const fixture = await createFixtureOrg(db, { domain: "obj-detail.test" });
      const [initiativeB] = await db
        .insert(initiatives)
        .values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Initiative B" })
        .returning();

      const response = await app.inject({
        method: "GET",
        url: `/api/objectives/${fixture.objective.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        objective: { id: string; title: string; description: string | null; owner: string | null };
        initiatives: Array<{ id: string; title: string; owner: string | null }>;
      };
      expect(body.objective.id).toBe(fixture.objective.id);
      expect(body.objective.title).toBe("Test objective");
      expect(body.objective.owner).toBeNull();
      const initiativeIds = body.initiatives.map((i) => i.id);
      expect(initiativeIds).toContain(fixture.initiative.id);
      expect(initiativeIds).toContain(initiativeB.id);
      expect(body.initiatives).toHaveLength(2);
      expect(body.initiatives.find((i) => i.id === fixture.initiative.id)!.owner).toBeNull();
    });

    it("404s for a nonexistent id", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "obj-missing.test" });
      const response = await app.inject({
        method: "GET",
        url: `/api/objectives/${randomUUID()}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });

    it("404s (not the other org's data) for an id belonging to a different organization", async () => {
      const orgA = await createFixtureOrg(db, { domain: "obj-org-a.test" });
      const orgB = await createFixtureOrg(db, { domain: "obj-org-b.test" });

      const app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/objectives/${orgB.objective.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/initiatives/:id", () => {
    it("returns full detail plus parent objective and its projects", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "init-detail.test" });
      const [projectB] = await db
        .insert(projects)
        .values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Project B", owner: "Sean Meehan" })
        .returning();

      const response = await app.inject({
        method: "GET",
        url: `/api/initiatives/${fixture.initiative.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        initiative: { id: string; title: string; owner: string | null };
        objective: { id: string; title: string } | null;
        projects: Array<{ id: string; title: string; owner: string | null }>;
      };
      expect(body.initiative.id).toBe(fixture.initiative.id);
      expect(body.initiative.owner).toBeNull();
      expect(body.objective?.id).toBe(fixture.objective.id);
      const projectIds = body.projects.map((p) => p.id);
      expect(projectIds).toContain(fixture.project.id);
      expect(projectIds).toContain(projectB.id);
      expect(body.projects).toHaveLength(2);
      expect(body.projects.find((p) => p.id === projectB.id)!.owner).toBe("Sean Meehan");
    });

    it("rolls up task-status counts across all of this initiative's projects, org-scoped", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "init-rollup.test" });
      const otherOrg = await createFixtureOrg(db, { domain: "init-rollup-other.test" });

      const [projectB] = await db
        .insert(projects)
        .values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Project B" })
        .returning();

      await db.insert(tasks).values([
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T1", status: "active" },
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T2", status: "active" },
        { organizationId: fixture.org.id, projectId: projectB.id, title: "T3", status: "blocked" },
        { organizationId: fixture.org.id, projectId: projectB.id, title: "T4", status: "completed" },
        // A task under a different organization's initiative must never
        // bleed into this rollup.
        { organizationId: otherOrg.org.id, projectId: otherOrg.project.id, title: "Other org task", status: "active" },
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/initiatives/${fixture.initiative.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as { taskCounts: Record<string, number> };
      expect(body.taskCounts).toEqual({
        active: 2,
        waiting: 0,
        needs_attention: 0,
        completed: 1,
        superseded: 0,
        resolved: 0,
        blocked: 1,
      });
    });

    it("returns 401 for an unauthenticated request", async () => {
      const app = await buildApp();
      const response = await app.inject({ method: "GET", url: `/api/initiatives/${randomUUID()}` });
      await app.close();
      expect(response.statusCode).toBe(401);
    });

    it("404s for a nonexistent id", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "init-missing.test" });
      const response = await app.inject({
        method: "GET",
        url: `/api/initiatives/${randomUUID()}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });

    it("404s for an initiative belonging to a different organization", async () => {
      const orgA = await createFixtureOrg(db, { domain: "init-org-a.test" });
      const orgB = await createFixtureOrg(db, { domain: "init-org-b.test" });

      const app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/initiatives/${orgB.initiative.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/projects/:id", () => {
    it("returns full detail plus parent initiative and its tasks", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "proj-detail.test" });
      await db.insert(tasks).values([
        {
          organizationId: fixture.org.id,
          projectId: fixture.project.id,
          title: "Task A",
          status: "active",
          latestUpdate: "Made progress",
          nextAction: "Ship it",
          owner: "Sean Meehan",
        },
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task B", status: "blocked" },
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${fixture.project.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        project: { id: string; title: string; owner: string | null };
        initiative: { id: string; title: string } | null;
        tasks: Array<{
          id: string;
          title: string;
          status: string;
          latestUpdate: string | null;
          nextAction: string | null;
          owner: string | null;
        }>;
      };
      expect(body.project.id).toBe(fixture.project.id);
      expect(body.project.owner).toBeNull();
      expect(body.initiative?.id).toBe(fixture.initiative.id);
      expect(body.tasks).toHaveLength(2);
      const taskA = body.tasks.find((t) => t.title === "Task A");
      expect(taskA?.latestUpdate).toBe("Made progress");
      expect(taskA?.nextAction).toBe("Ship it");
      expect(taskA?.owner).toBe("Sean Meehan");
      const taskB = body.tasks.find((t) => t.title === "Task B");
      expect(taskB?.owner).toBeNull();
    });

    it("rolls up task-status counts across this project's own tasks, org-scoped", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "proj-rollup.test" });
      const otherOrg = await createFixtureOrg(db, { domain: "proj-rollup-other.test" });

      await db.insert(tasks).values([
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T1", status: "active" },
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T2", status: "needs_attention" },
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T3", status: "needs_attention" },
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "T4", status: "resolved" },
        // A task under a different organization's project must never bleed
        // into this rollup.
        { organizationId: otherOrg.org.id, projectId: otherOrg.project.id, title: "Other org task", status: "active" },
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${fixture.project.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as { taskCounts: Record<string, number> };
      expect(body.taskCounts).toEqual({
        active: 1,
        waiting: 0,
        needs_attention: 2,
        completed: 0,
        superseded: 0,
        resolved: 1,
        blocked: 0,
      });
    });

    it("returns 401 for an unauthenticated request", async () => {
      const app = await buildApp();
      const response = await app.inject({ method: "GET", url: `/api/projects/${randomUUID()}` });
      await app.close();
      expect(response.statusCode).toBe(401);
    });

    it("404s for a nonexistent id", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "proj-missing.test" });
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${randomUUID()}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });

    it("404s for a project belonging to a different organization", async () => {
      const orgA = await createFixtureOrg(db, { domain: "proj-org-a.test" });
      const orgB = await createFixtureOrg(db, { domain: "proj-org-b.test" });

      const app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${orgB.project.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/tasks/:id", () => {
    it("returns full detail plus the full breadcrumb chain and approved suggestions", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "task-detail.test" });
      const [task] = await db
        .insert(tasks)
        .values({
          organizationId: fixture.org.id,
          projectId: fixture.project.id,
          title: "Investigate defect",
          status: "active",
          latestUpdate: "Root cause found",
          nextAction: "File CAPA",
          owner: "Sean Meehan",
        })
        .returning();

      const [approved] = await db
        .insert(suggestions)
        .values({
          organizationId: fixture.org.id,
          sourceId: fixture.source.id,
          targetType: "task",
          targetId: task.id,
          changeType: "operational_update",
          proposedDiff: { latestUpdate: "Root cause found" },
          reasoning: "Meeting notes mentioned root cause",
          confidence: 0.9,
          status: "approved",
          reviewedBy: fixture.user.id,
          reviewedAt: new Date(),
        })
        .returning();

      // A pending suggestion targeting the same task must not show up.
      await db.insert(suggestions).values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: task.id,
        changeType: "context",
        proposedDiff: {},
        reasoning: "Still pending",
        confidence: 0.5,
        status: "pending",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/tasks/${task.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        task: { id: string; title: string; latestUpdate: string | null; owner: string | null };
        project: { id: string; title: string } | null;
        initiative: { id: string; title: string } | null;
        objective: { id: string; title: string } | null;
        approvedSuggestions: Array<{ id: string; reasoning: string }>;
      };
      expect(body.task.id).toBe(task.id);
      expect(body.task.latestUpdate).toBe("Root cause found");
      expect(body.task.owner).toBe("Sean Meehan");
      expect(body.project?.id).toBe(fixture.project.id);
      expect(body.initiative?.id).toBe(fixture.initiative.id);
      expect(body.objective?.id).toBe(fixture.objective.id);
      expect(body.approvedSuggestions).toHaveLength(1);
      expect(body.approvedSuggestions[0].id).toBe(approved.id);
    });

    it("shows the real source date, not the DB row's own updatedAt, when built from a historical document", async () => {
      const fixture = await createFixtureOrg(db, { domain: "task-detail-real-updated-date.test" });
      const historicalDate = new Date("2020-07-28T00:00:00.000Z");
      const [source] = await db
        .insert(sources)
        .values({ organizationId: fixture.org.id, type: "document", externalId: "2020-status-meeting", receivedAt: historicalDate })
        .returning();

      const [task] = await db
        .insert(tasks)
        .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Animal study justification/rationale", status: "needs_attention" })
        .returning();
      await db.insert(suggestions).values({
        organizationId: fixture.org.id,
        sourceId: source.id,
        targetType: "task",
        targetId: task.id,
        changeType: "new_task",
        proposedDiff: { title: "Animal study justification/rationale", status: "needs_attention" },
        reasoning: "test",
        confidence: 0.6,
        status: "approved",
      });

      const app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/tasks/${task.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      const body = response.json() as { task: { updatedAt: string } };
      expect(body.task.updatedAt).toBe(historicalDate.toISOString());
      expect(new Date(task.updatedAt).getFullYear()).toBeGreaterThan(2020);
    });

    it("includes the blocking open decision, but not a decided one", async () => {
      const fixture = await createFixtureOrg(db, { domain: "task-blocking-decision.test" });
      const [blockedTask] = await db
        .insert(tasks)
        .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Blocked task", status: "blocked" })
        .returning();

      const openDecision = await createDecision(db, {
        organizationId: fixture.org.id,
        actorId: fixture.user.id,
        title: "Approve vendor switch",
        decider: "CEO",
        relatedTaskId: blockedTask.id,
      });

      const app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/tasks/${blockedTask.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as { blockingDecision: { id: string; title: string } | null };
      expect(body.blockingDecision).toEqual({ id: openDecision.id, title: "Approve vendor switch" });

      // Once resolved, it should no longer show as the blocker.
      await resolveDecision(db, {
        organizationId: fixture.org.id,
        decisionId: openDecision.id,
        actorId: fixture.user.id,
        resolution: "Approved vendor B",
      });
      const app2 = await buildApp();
      const response2 = await app2.inject({
        method: "GET",
        url: `/api/tasks/${blockedTask.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app2.close();
      const body2 = response2.json() as { blockingDecision: { id: string; title: string } | null };
      expect(body2.blockingDecision).toBeNull();
    });

    it("returns 401 for an unauthenticated request", async () => {
      const app = await buildApp();
      const response = await app.inject({ method: "GET", url: `/api/tasks/${randomUUID()}` });
      await app.close();
      expect(response.statusCode).toBe(401);
    });

    it("404s for a nonexistent id", async () => {
      const app = await buildApp();
      const fixture = await createFixtureOrg(db, { domain: "task-missing.test" });
      const response = await app.inject({
        method: "GET",
        url: `/api/tasks/${randomUUID()}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });

    it("404s for a task belonging to a different organization", async () => {
      const orgA = await createFixtureOrg(db, { domain: "task-org-a.test" });
      const orgB = await createFixtureOrg(db, { domain: "task-org-b.test" });
      const [taskB] = await db
        .insert(tasks)
        .values({ organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B task" })
        .returning();

      const app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/tasks/${taskB.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });
  });
});
