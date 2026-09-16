import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, initiatives, objectives, projects, suggestions, tasks } from "../db/schema.js";
import { createDecision, resolveDecision } from "../decisions/manage.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

const ZERO_TASK_COUNTS = {
  active: 0,
  waiting: 0,
  needs_attention: 0,
  completed: 0,
  superseded: 0,
  resolved: 0,
  blocked: 0,
};

async function getAsUser(fixture: Awaited<ReturnType<typeof createFixtureOrg>>, url: string) {
  const app = await buildApp();
  const token = await signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: fixture.authorization.role,
  });
  const response = await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE_NAME]: token } });
  await app.close();
  return response;
}

describe("GET /api/dashboard/status-summary", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/dashboard/status-summary" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns correct org-wide counts across a mixed-status fixture set, org-isolated", async () => {
    const fixture = await createFixtureOrg(db, { domain: "status-summary.test" });
    const otherOrg = await createFixtureOrg(db, { domain: "status-summary-other.test" });

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
      { organizationId: fixture.org.id, projectId: projectB.id, title: "T4", status: "needs_attention" },
      { organizationId: fixture.org.id, projectId: projectB.id, title: "T5", status: "needs_attention" },
      { organizationId: fixture.org.id, projectId: projectB.id, title: "T6", status: "waiting" },
      { organizationId: fixture.org.id, projectId: projectB.id, title: "T7", status: "completed" },
      { organizationId: fixture.org.id, projectId: projectB.id, title: "T8", status: "resolved" },
      { organizationId: fixture.org.id, projectId: projectB.id, title: "T9", status: "superseded" },
      // Belongs to a different org -- must never bleed into this org's counts.
      { organizationId: otherOrg.org.id, projectId: otherOrg.project.id, title: "Other org task", status: "blocked" },
    ]);

    const response = await getAsUser(fixture, "/api/dashboard/status-summary");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { taskCounts: Record<string, number> };
    expect(body.taskCounts).toEqual({
      ...ZERO_TASK_COUNTS,
      active: 2,
      blocked: 1,
      needs_attention: 2,
      waiting: 1,
      completed: 1,
      resolved: 1,
      superseded: 1,
    });
  });

  it("returns all-zero counts for an org with no tasks", async () => {
    const fixture = await createFixtureOrg(db, { domain: "status-summary-empty.test" });
    const response = await getAsUser(fixture, "/api/dashboard/status-summary");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { taskCounts: Record<string, number> };
    expect(body.taskCounts).toEqual(ZERO_TASK_COUNTS);
  });
});

describe("GET /api/dashboard/needs-attention", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/dashboard/needs-attention" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("includes only blocked/needs_attention tasks, with owner and full parent-chain titles", async () => {
    const fixture = await createFixtureOrg(db, { domain: "needs-attention.test" });

    await db.insert(tasks).values([
      {
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Blocked task",
        status: "blocked",
        owner: "Sean Meehan",
        latestUpdate: "Waiting on vendor",
        nextAction: "Escalate to procurement",
      },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Active task", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Done task", status: "completed" },
    ]);

    const response = await getAsUser(fixture, "/api/dashboard/needs-attention");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      tasks: Array<{
        title: string;
        status: string;
        owner: string | null;
        latestUpdate: string | null;
        nextAction: string | null;
        project: { id: string; title: string };
        initiative: { id: string; title: string };
        objective: { id: string; title: string };
      }>;
    };
    expect(body.tasks).toHaveLength(1);
    const [row] = body.tasks;
    expect(row.title).toBe("Blocked task");
    expect(row.status).toBe("blocked");
    expect(row.owner).toBe("Sean Meehan");
    expect(row.latestUpdate).toBe("Waiting on vendor");
    expect(row.nextAction).toBe("Escalate to procurement");
    expect(row.project.id).toBe(fixture.project.id);
    expect(row.initiative.id).toBe(fixture.initiative.id);
    expect(row.objective.id).toBe(fixture.objective.id);
  });

  it("orders blocked before needs_attention, and oldest-updated first within each status when priority ties", async () => {
    const fixture = await createFixtureOrg(db, { domain: "needs-attention-order.test" });

    const [older] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Older blocked", status: "blocked" })
      .returning();
    const [newer] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Newer blocked", status: "blocked" })
      .returning();
    const [attention] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Needs attention", status: "needs_attention" })
      .returning();

    // Force a clear updatedAt ordering: older < newer < attention. All three
    // tasks share the same (default "medium") objective priority, so the
    // tiebreak here is purely severity then staleness: both blocked rows
    // outrank needs_attention regardless of recency, and within the blocked
    // tier the STALER row (older) surfaces first -- this endpoint
    // deliberately sorts oldest-updated-first, not most-recent-first, so a
    // task stuck the longest is the most visible.
    await db.update(tasks).set({ updatedAt: new Date("2026-01-01") }).where(eq(tasks.id, older.id));
    await db.update(tasks).set({ updatedAt: new Date("2026-01-02") }).where(eq(tasks.id, newer.id));
    await db.update(tasks).set({ updatedAt: new Date("2026-01-03") }).where(eq(tasks.id, attention.id));

    const response = await getAsUser(fixture, "/api/dashboard/needs-attention");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tasks: Array<{ id: string }> };
    expect(body.tasks.map((t) => t.id)).toEqual([older.id, newer.id, attention.id]);
  });

  it("ranks a critical-priority blocked task ahead of a low-priority blocked task that's been stuck longer", async () => {
    const fixture = await createFixtureOrg(db, { domain: "needs-attention-priority.test" });

    // A second objective/initiative/project chain with a distinct priority,
    // so the low-priority task's parent objective differs from the fixture's
    // default-priority ("medium") one.
    const [lowObjective] = await db
      .insert(objectives)
      .values({ organizationId: fixture.org.id, title: "Low priority objective", priority: "low" })
      .returning();
    const [lowInitiative] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: lowObjective.id, title: "Low initiative" })
      .returning();
    const [lowProject] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: lowInitiative.id, title: "Low project" })
      .returning();

    await db
      .update(objectives)
      .set({ priority: "critical" })
      .where(eq(objectives.id, fixture.objective.id));

    const [lowPriorityStale] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: lowProject.id, title: "Low priority, very stale", status: "blocked" })
      .returning();
    const [criticalPriorityFresh] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Critical priority, just blocked", status: "blocked" })
      .returning();

    // The low-priority task has been stuck far longer, but priority beats
    // staleness -- it must NOT outrank the critical-priority task.
    await db.update(tasks).set({ updatedAt: new Date("2020-01-01") }).where(eq(tasks.id, lowPriorityStale.id));
    await db.update(tasks).set({ updatedAt: new Date("2026-01-01") }).where(eq(tasks.id, criticalPriorityFresh.id));

    const response = await getAsUser(fixture, "/api/dashboard/needs-attention");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tasks: Array<{ id: string }> };
    expect(body.tasks.map((t) => t.id)).toEqual([criticalPriorityFresh.id, lowPriorityStale.id]);
  });

  it("includes a blocking open decision's id/title on a blocked task, but not one pointing at a decided decision", async () => {
    const fixture = await createFixtureOrg(db, { domain: "needs-attention-blocking-decision.test" });

    const [blockedWithOpenDecision] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Blocked, has open decision", status: "blocked" })
      .returning();
    const [blockedWithDecidedDecision] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Blocked, only decided decision", status: "blocked" })
      .returning();

    const openDecision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Approve vendor switch",
      decider: "CEO",
      relatedTaskId: blockedWithOpenDecision.id,
    });

    const decidedDecision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Already-settled decision",
      decider: "CEO",
      relatedTaskId: blockedWithDecidedDecision.id,
    });
    await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decidedDecision.id,
      actorId: fixture.user.id,
      resolution: "Settled",
    });

    const response = await getAsUser(fixture, "/api/dashboard/needs-attention");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      tasks: Array<{ id: string; blockingDecision: { id: string; title: string } | null }>;
    };

    const withOpen = body.tasks.find((t) => t.id === blockedWithOpenDecision.id);
    expect(withOpen?.blockingDecision).toEqual({ id: openDecision.id, title: "Approve vendor switch" });

    const withDecided = body.tasks.find((t) => t.id === blockedWithDecidedDecision.id);
    expect(withDecided?.blockingDecision).toBeNull();
  });

  it("tags each task with its all-time count of approved suggestions, excluding pending ones", async () => {
    const fixture = await createFixtureOrg(db, { domain: "needs-attention-source-count.test" });

    const [cited] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Cited", status: "blocked" })
      .returning();
    const [uncited] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Uncited", status: "blocked" })
      .returning();

    await db.insert(suggestions).values([
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: cited.id,
        changeType: "operational_update",
        proposedDiff: {},
        reasoning: "Approved one",
        confidence: 0.8,
        status: "approved",
      },
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: cited.id,
        changeType: "operational_update",
        proposedDiff: {},
        reasoning: "Still pending",
        confidence: 0.5,
        status: "pending",
      },
    ]);

    const response = await getAsUser(fixture, "/api/dashboard/needs-attention");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tasks: Array<{ id: string; sourceCount: number }> };

    expect(body.tasks.find((t) => t.id === cited.id)?.sourceCount).toBe(1);
    expect(body.tasks.find((t) => t.id === uncited.id)?.sourceCount).toBe(0);
  });

  it("never returns a task belonging to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "needs-attention-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "needs-attention-org-b.test" });

    await db.insert(tasks).values([
      { organizationId: orgA.org.id, projectId: orgA.project.id, title: "Org A blocked", status: "blocked" },
      { organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B blocked", status: "blocked" },
    ]);

    const response = await getAsUser(orgA, "/api/dashboard/needs-attention");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tasks: Array<{ title: string }> };
    expect(body.tasks.map((t) => t.title)).toEqual(["Org A blocked"]);
  });
});

describe("GET /api/dashboard/recent-progress", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/dashboard/recent-progress" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("includes only completed/resolved tasks, ordered by updatedAt desc", async () => {
    const fixture = await createFixtureOrg(db, { domain: "recent-progress.test" });

    const [oldCompleted] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Old completed", status: "completed" })
      .returning();
    const [newResolved] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "New resolved", status: "resolved" })
      .returning();
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Still active", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Superseded", status: "superseded" },
    ]);

    await db.update(tasks).set({ updatedAt: new Date("2026-01-01") }).where(eq(tasks.id, oldCompleted.id));
    await db.update(tasks).set({ updatedAt: new Date("2026-01-05") }).where(eq(tasks.id, newResolved.id));

    const response = await getAsUser(fixture, "/api/dashboard/recent-progress");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tasks: Array<{ id: string; title: string; status: string }> };
    expect(body.tasks.map((t) => t.id)).toEqual([newResolved.id, oldCompleted.id]);
    expect(body.tasks.map((t) => t.status)).toEqual(["resolved", "completed"]);
  });

  it("tags each task with its all-time count of approved suggestions", async () => {
    const fixture = await createFixtureOrg(db, { domain: "recent-progress-source-count.test" });

    const [completed] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Completed", status: "completed" })
      .returning();

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: completed.id,
      changeType: "operational_update",
      proposedDiff: {},
      reasoning: "Approved",
      confidence: 0.8,
      status: "approved",
    });

    const response = await getAsUser(fixture, "/api/dashboard/recent-progress");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tasks: Array<{ id: string; sourceCount: number }> };
    expect(body.tasks.find((t) => t.id === completed.id)?.sourceCount).toBe(1);
  });

  it("never returns a task belonging to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "recent-progress-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "recent-progress-org-b.test" });

    await db.insert(tasks).values([
      { organizationId: orgA.org.id, projectId: orgA.project.id, title: "Org A done", status: "completed" },
      { organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B done", status: "completed" },
    ]);

    const response = await getAsUser(orgA, "/api/dashboard/recent-progress");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { tasks: Array<{ title: string }> };
    expect(body.tasks.map((t) => t.title)).toEqual(["Org A done"]);
  });
});
