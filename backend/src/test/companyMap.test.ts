import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { initiatives, projects, suggestions, tasks } from "../db/schema.js";
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
        objective: { id: string; title: string; description: string | null };
        initiatives: Array<{ id: string; title: string }>;
      };
      expect(body.objective.id).toBe(fixture.objective.id);
      expect(body.objective.title).toBe("Test objective");
      const initiativeIds = body.initiatives.map((i) => i.id);
      expect(initiativeIds).toContain(fixture.initiative.id);
      expect(initiativeIds).toContain(initiativeB.id);
      expect(body.initiatives).toHaveLength(2);
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
        .values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Project B" })
        .returning();

      const response = await app.inject({
        method: "GET",
        url: `/api/initiatives/${fixture.initiative.id}`,
        cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        initiative: { id: string; title: string };
        objective: { id: string; title: string } | null;
        projects: Array<{ id: string; title: string }>;
      };
      expect(body.initiative.id).toBe(fixture.initiative.id);
      expect(body.objective?.id).toBe(fixture.objective.id);
      const projectIds = body.projects.map((p) => p.id);
      expect(projectIds).toContain(fixture.project.id);
      expect(projectIds).toContain(projectB.id);
      expect(body.projects).toHaveLength(2);
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
        project: { id: string; title: string };
        initiative: { id: string; title: string } | null;
        tasks: Array<{ id: string; title: string; status: string; latestUpdate: string | null; nextAction: string | null }>;
      };
      expect(body.project.id).toBe(fixture.project.id);
      expect(body.initiative?.id).toBe(fixture.initiative.id);
      expect(body.tasks).toHaveLength(2);
      const taskA = body.tasks.find((t) => t.title === "Task A");
      expect(taskA?.latestUpdate).toBe("Made progress");
      expect(taskA?.nextAction).toBe("Ship it");
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
        task: { id: string; title: string; latestUpdate: string | null };
        project: { id: string; title: string } | null;
        initiative: { id: string; title: string } | null;
        objective: { id: string; title: string } | null;
        approvedSuggestions: Array<{ id: string; reasoning: string }>;
      };
      expect(body.task.id).toBe(task.id);
      expect(body.task.latestUpdate).toBe("Root cause found");
      expect(body.project?.id).toBe(fixture.project.id);
      expect(body.initiative?.id).toBe(fixture.initiative.id);
      expect(body.objective?.id).toBe(fixture.objective.id);
      expect(body.approvedSuggestions).toHaveLength(1);
      expect(body.approvedSuggestions[0].id).toBe(approved.id);
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
