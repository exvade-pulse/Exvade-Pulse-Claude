import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, decisions, tasks } from "../db/schema.js";
import { createDecision, resolveDecision, updateDecision, DecisionError } from "../decisions/manage.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

async function insertTask(orgId: string, projectId: string, title: string) {
  const [task] = await db.insert(tasks).values({ organizationId: orgId, projectId, title }).returning();
  return task;
}

describe("decisions module", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("creating a decision persists it and writes an audit_log row", async () => {
    const fixture = await createFixtureOrg(db, { domain: "create-decision.test" });
    const task = await insertTask(fixture.org.id, fixture.project.id, "Evaluate sensor board vendors");

    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Approve vendor switch for sensor boards",
      whyItMatters: "Current vendor's lead time jeopardizes the pivotal trial timeline.",
      relevantContext: "Two alternate vendors have passed initial qualification.",
      suggestedNextStep: "Approve Vendor B pending final quote.",
      decider: "Sean Meehan, CEO",
      stakeholders: ["Ops lead", "Board of Directors"],
      dueDate: new Date("2026-10-01"),
      relatedTaskId: task.id,
    });

    const [row] = await db.select().from(decisions).where(eq(decisions.id, decision.id));
    expect(row).toBeDefined();
    expect(row.status).toBe("open");
    expect(row.stakeholders).toEqual(["Ops lead", "Board of Directors"]);
    expect(row.relatedTaskId).toBe(task.id);
    expect(row.whyItMatters).toContain("lead time");

    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, decision.id), eq(auditLog.action, "decision.created")));
    expect(logRow).toBeDefined();
    expect(logRow.organizationId).toBe(fixture.org.id);
  });

  it("rejects a relatedTaskId belonging to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "decision-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "decision-org-b.test" });
    const taskB = await insertTask(orgB.org.id, orgB.project.id, "Org B task");

    await expect(
      createDecision(db, {
        organizationId: orgA.org.id,
        actorId: orgA.user.id,
        title: "Cross-org attempt",
        decider: "Someone",
        relatedTaskId: taskB.id, // belongs to org B
      }),
    ).rejects.toBeInstanceOf(DecisionError);

    const rows = await db.select().from(decisions).where(eq(decisions.organizationId, orgA.org.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects a sourceId belonging to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "decision-src-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "decision-src-b.test" });

    await expect(
      createDecision(db, {
        organizationId: orgA.org.id,
        actorId: orgA.user.id,
        title: "Cross-org source attempt",
        decider: "Someone",
        sourceId: orgB.source.id, // belongs to org B
      }),
    ).rejects.toBeInstanceOf(DecisionError);
  });

  it("resolving an open decision sets status/decidedAt/resolution and writes an audit_log row", async () => {
    const fixture = await createFixtureOrg(db, { domain: "resolve-decision.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Pick clinical trial site",
      decider: "Board of Directors",
    });

    const updated = await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Selected Site B, better enrollment projections",
    });

    expect(updated.status).toBe("decided");
    expect(updated.resolution).toBe("Selected Site B, better enrollment projections");
    expect(updated.decidedAt).not.toBeNull();

    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, decision.id), eq(auditLog.action, "decision.resolved")));
    expect(logRow).toBeDefined();
  });

  it("rejects resolving an already-decided decision", async () => {
    const fixture = await createFixtureOrg(db, { domain: "double-resolve.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Pick manufacturing partner",
      decider: "CEO",
    });

    await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Chose Partner A",
    });

    await expect(
      resolveDecision(db, {
        organizationId: fixture.org.id,
        decisionId: decision.id,
        actorId: fixture.user.id,
        resolution: "Chose Partner B",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("cannot resolve a decision belonging to another organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "resolve-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "resolve-org-b.test" });

    const decision = await createDecision(db, {
      organizationId: orgA.org.id,
      actorId: orgA.user.id,
      title: "Org A only",
      decider: "CEO",
    });

    await expect(
      resolveDecision(db, {
        organizationId: orgB.org.id, // wrong org
        decisionId: decision.id,
        actorId: orgB.user.id,
        resolution: "Hijacked",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("updating a decision changes only the given fields and writes a decision.updated audit_log row", async () => {
    const fixture = await createFixtureOrg(db, { domain: "update-decision.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Original title",
      decider: "Leadership",
      stakeholders: ["Finance"],
      whyItMatters: "Original reason.",
    });

    const updated = await updateDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      fields: { relevantContext: "New context from a follow-up email." },
    });

    expect(updated.relevantContext).toBe("New context from a follow-up email.");
    expect(updated.title).toBe("Original title"); // untouched field stays as-is
    expect(updated.decider).toBe("Leadership");
    expect(updated.stakeholders).toEqual(["Finance"]);

    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, decision.id), eq(auditLog.action, "decision.updated")));
    expect(logRow).toBeDefined();
    expect(logRow.actorId).toBe(fixture.user.id);
  });

  it("rejects updating a decision that belongs to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "update-decision-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "update-decision-org-b.test" });

    const decisionB = await createDecision(db, {
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      title: "Belongs to org B",
      decider: "CEO",
    });

    await expect(
      updateDecision(db, {
        organizationId: orgA.org.id,
        decisionId: decisionB.id,
        actorId: orgA.user.id,
        fields: { relevantContext: "Hijacked" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects updating an already-decided decision", async () => {
    const fixture = await createFixtureOrg(db, { domain: "update-decided.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Pick manufacturing partner",
      decider: "CEO",
    });
    await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Chose Partner A",
    });

    await expect(
      updateDecision(db, {
        organizationId: fixture.org.id,
        decisionId: decision.id,
        actorId: fixture.user.id,
        fields: { relevantContext: "Too late" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a relatedTaskId belonging to a different organization on update", async () => {
    const orgA = await createFixtureOrg(db, { domain: "update-decision-task-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "update-decision-task-b.test" });
    const taskB = await insertTask(orgB.org.id, orgB.project.id, "Org B task");

    const decision = await createDecision(db, {
      organizationId: orgA.org.id,
      actorId: orgA.user.id,
      title: "Org A decision",
      decider: "CEO",
    });

    await expect(
      updateDecision(db, {
        organizationId: orgA.org.id,
        decisionId: decision.id,
        actorId: orgA.user.id,
        fields: { relatedTaskId: taskB.id },
      }),
    ).rejects.toBeInstanceOf(DecisionError);
  });
});

describe("GET/POST /api/decisions", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/decisions" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("defaults to listing only open decisions; a decided one is excluded", async () => {
    const fixture = await createFixtureOrg(db, { domain: "list-open.test" });
    const open = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Still open",
      decider: "CEO",
    });
    const decided = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Already decided",
      decider: "CEO",
    });
    await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decided.id,
      actorId: fixture.user.id,
      resolution: "Done",
    });

    const app = await buildApp();
    const token = await signSession({
      userId: fixture.user.id,
      organizationId: fixture.org.id,
      email: fixture.user.email,
      role: fixture.authorization.role,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { decisions: Array<{ id: string }> };
    const ids = body.decisions.map((d) => d.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(decided.id);
  });

  it("includes the related task's title via join", async () => {
    const fixture = await createFixtureOrg(db, { domain: "join-task.test" });
    const task = await insertTask(fixture.org.id, fixture.project.id, "Investigate wiring harness defect");
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs context",
      decider: "CEO",
      relatedTaskId: task.id,
    });

    const app = await buildApp();
    const token = await signSession({
      userId: fixture.user.id,
      organizationId: fixture.org.id,
      email: fixture.user.email,
      role: fixture.authorization.role,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    await app.close();

    const body = response.json() as { decisions: Array<{ id: string; relatedTaskTitle: string | null }> };
    const row = body.decisions.find((d) => d.id === decision.id);
    expect(row?.relatedTaskTitle).toBe(task.title);
  });

  it("a logged-in user only sees and can only resolve their own organization's decisions via the API", async () => {
    const orgA = await createFixtureOrg(db, { domain: "api-decision-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "api-decision-org-b.test" });

    const decisionA = await createDecision(db, {
      organizationId: orgA.org.id,
      actorId: orgA.user.id,
      title: "Belongs to org A",
      decider: "CEO",
    });
    const decisionB = await createDecision(db, {
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      title: "Belongs to org B",
      decider: "CEO",
    });

    const app = await buildApp();
    const tokenA = await signSession({
      userId: orgA.user.id,
      organizationId: orgA.org.id,
      email: orgA.user.email,
      role: orgA.authorization.role,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { decisions: Array<{ id: string }> };
    const ids = body.decisions.map((d) => d.id);
    expect(ids).toContain(decisionA.id);
    expect(ids).not.toContain(decisionB.id);

    const crossOrgResolve = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${decisionB.id}/resolve`,
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
      payload: { resolution: "Hijacked via API" },
    });
    expect(crossOrgResolve.statusCode).toBe(404);

    await app.close();
  });

  it("creates a decision via the API and rejects a cross-org relatedTaskId", async () => {
    const orgA = await createFixtureOrg(db, { domain: "api-create-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "api-create-b.test" });
    const taskB = await insertTask(orgB.org.id, orgB.project.id, "Org B task");

    const app = await buildApp();
    const tokenA = await signSession({
      userId: orgA.user.id,
      organizationId: orgA.org.id,
      email: orgA.user.email,
      role: orgA.authorization.role,
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
      payload: {
        title: "Approve budget increase",
        decider: "CFO",
        stakeholders: ["Finance", "Board"],
      },
    });
    expect(created.statusCode).toBe(201);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
      payload: {
        title: "Cross-org task",
        decider: "CFO",
        relatedTaskId: taskB.id,
      },
    });
    expect(rejected.statusCode).toBe(404);

    await app.close();
  });
});
