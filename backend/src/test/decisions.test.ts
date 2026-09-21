import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, decisions, sources, suggestions, tasks } from "../db/schema.js";
import {
  addDecisionInfo,
  assignDecision,
  createDecision,
  resolveDecision,
  updateDecision,
  DecisionError,
} from "../decisions/manage.js";
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

    const { decision: updated, unblockedTask } = await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Selected Site B, better enrollment projections",
    });

    expect(updated.status).toBe("decided");
    expect(updated.resolution).toBe("Selected Site B, better enrollment projections");
    expect(unblockedTask).toBeNull();
    expect(updated.decidedAt).not.toBeNull();

    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, decision.id), eq(auditLog.action, "decision.resolved")));
    expect(logRow).toBeDefined();
  });

  it("alsoUnblockTask: true with a blocked related task flips it to active and writes both audit_log rows in the same resolve", async () => {
    const fixture = await createFixtureOrg(db, { domain: "resolve-unblock.test" });
    const blockedTask = await insertTask(fixture.org.id, fixture.project.id, "Blocked on vendor decision");
    await db.update(tasks).set({ status: "blocked" }).where(eq(tasks.id, blockedTask.id));

    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Approve vendor switch",
      decider: "CEO",
      relatedTaskId: blockedTask.id,
    });

    const { decision: updated, unblockedTask } = await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Approved vendor B",
      alsoUnblockTask: true,
    });

    expect(updated.status).toBe("decided");
    expect(unblockedTask).not.toBeNull();
    expect(unblockedTask?.status).toBe("active");

    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, blockedTask.id));
    expect(taskRow.status).toBe("active");

    const [resolvedLog] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, decision.id), eq(auditLog.action, "decision.resolved")));
    expect(resolvedLog).toBeDefined();

    const [unblockLog] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, blockedTask.id), eq(auditLog.action, "task.unblocked_via_decision")));
    expect(unblockLog).toBeDefined();
    expect(unblockLog.organizationId).toBe(fixture.org.id);
  });

  it("alsoUnblockTask: false leaves a blocked related task untouched", async () => {
    const fixture = await createFixtureOrg(db, { domain: "resolve-no-unblock.test" });
    const blockedTask = await insertTask(fixture.org.id, fixture.project.id, "Blocked on vendor decision");
    await db.update(tasks).set({ status: "blocked" }).where(eq(tasks.id, blockedTask.id));

    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Approve vendor switch",
      decider: "CEO",
      relatedTaskId: blockedTask.id,
    });

    const { unblockedTask } = await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Approved vendor B",
    });

    expect(unblockedTask).toBeNull();
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, blockedTask.id));
    expect(taskRow.status).toBe("blocked");

    const unblockLogs = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, blockedTask.id), eq(auditLog.action, "task.unblocked_via_decision")));
    expect(unblockLogs).toHaveLength(0);
  });

  it("alsoUnblockTask: true does nothing when the related task isn't currently blocked", async () => {
    const fixture = await createFixtureOrg(db, { domain: "resolve-unblock-not-blocked.test" });
    // Default task status is "active", not blocked.
    const activeTask = await insertTask(fixture.org.id, fixture.project.id, "Already active");

    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Some other decision",
      decider: "CEO",
      relatedTaskId: activeTask.id,
    });

    const { unblockedTask } = await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Decided",
      alsoUnblockTask: true,
    });

    expect(unblockedTask).toBeNull();
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, activeTask.id));
    expect(taskRow.status).toBe("active");
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

  it("addDecisionInfo appends an attributed, dated entry rather than overwriting existing context", async () => {
    const fixture = await createFixtureOrg(db, { domain: "add-info-append.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs a call",
      decider: "CEO",
      relevantContext: "Original context from the meeting.",
    });

    const updated = await addDecisionInfo(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      actorLabel: fixture.user.email,
      note: "Vendor confirmed pricing is firm through end of quarter.",
    });

    expect(updated.relevantContext).toContain("Original context from the meeting.");
    expect(updated.relevantContext).toContain("Vendor confirmed pricing is firm through end of quarter.");
    expect(updated.relevantContext).toContain(fixture.user.email);

    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, decision.id), eq(auditLog.action, "decision.info_added")));
    expect(logRow).toBeDefined();
  });

  it("addDecisionInfo on a decision with no prior context sets it, rather than prefixing a stray blank line", async () => {
    const fixture = await createFixtureOrg(db, { domain: "add-info-empty.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs a call",
      decider: "CEO",
    });

    const updated = await addDecisionInfo(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      actorLabel: fixture.user.email,
      note: "First piece of context.",
    });

    expect(updated.relevantContext).not.toMatch(/^\s/);
    expect(updated.relevantContext).toContain("First piece of context.");
  });

  it("addDecisionInfo rejects a decision that has already been decided", async () => {
    const fixture = await createFixtureOrg(db, { domain: "add-info-conflict.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Already handled",
      decider: "CEO",
    });
    await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Done",
    });

    await expect(
      addDecisionInfo(db, {
        organizationId: fixture.org.id,
        decisionId: decision.id,
        actorId: fixture.user.id,
        actorLabel: fixture.user.email,
        note: "Too late",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("assignDecision changes the decider and writes an audit_log row with the previous value", async () => {
    const fixture = await createFixtureOrg(db, { domain: "assign-decision.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs an owner",
      decider: "Unassigned",
    });

    const updated = await assignDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      decider: "Sean Meehan, CEO",
    });

    expect(updated.decider).toBe("Sean Meehan, CEO");

    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, decision.id), eq(auditLog.action, "decision.assigned")));
    expect(logRow).toBeDefined();
    expect(logRow.details).toMatchObject({ previousDecider: "Unassigned", decider: "Sean Meehan, CEO" });
  });

  it("assignDecision rejects a decision that has already been decided", async () => {
    const fixture = await createFixtureOrg(db, { domain: "assign-conflict.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Already handled",
      decider: "CEO",
    });
    await resolveDecision(db, {
      organizationId: fixture.org.id,
      decisionId: decision.id,
      actorId: fixture.user.id,
      resolution: "Done",
    });

    await expect(
      assignDecision(db, {
        organizationId: fixture.org.id,
        decisionId: decision.id,
        actorId: fixture.user.id,
        decider: "Too late",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
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

  // Same real bug as company-map's: "updatedAt" must reflect the real
  // source date behind the decision's current content, not when the row
  // itself was last written to the database.
  it("shows the real source date, not the DB row's own updatedAt, for a decision built from a historical document", async () => {
    const fixture = await createFixtureOrg(db, { domain: "decisions-real-updated-date.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "An old open question",
      decider: "Leadership",
    });

    const historicalDate = new Date("2020-07-28T00:00:00.000Z");
    const [source] = await db
      .insert(sources)
      .values({ organizationId: fixture.org.id, type: "document", externalId: "2020-status-meeting", receivedAt: historicalDate })
      .returning();
    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: source.id,
      targetType: "decision",
      targetId: decision.id,
      changeType: "decision",
      proposedDiff: { relevantContext: "From the 2020 status meeting." },
      reasoning: "test",
      confidence: 0.6,
      status: "approved",
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

    const body = response.json() as { decisions: Array<{ id: string; updatedAt: string }> };
    const found = body.decisions.find((d) => d.id === decision.id);
    expect(found?.updatedAt).toBe(historicalDate.toISOString());
    expect(new Date(decision.updatedAt).getFullYear()).toBeGreaterThan(2020);
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

  it("includes the related task's current status, so the resolve UI knows whether to offer unblocking", async () => {
    const fixture = await createFixtureOrg(db, { domain: "join-task-status.test" });
    const task = await insertTask(fixture.org.id, fixture.project.id, "Investigate wiring harness defect");
    await db.update(tasks).set({ status: "blocked" }).where(eq(tasks.id, task.id));
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs context",
      decider: "CEO",
      relatedTaskId: task.id,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: await signSession({
        userId: fixture.user.id,
        organizationId: fixture.org.id,
        email: fixture.user.email,
        role: fixture.authorization.role,
      }) },
    });
    await app.close();

    const body = response.json() as { decisions: Array<{ id: string; relatedTaskStatus: string | null }> };
    const row = body.decisions.find((d) => d.id === decision.id);
    expect(row?.relatedTaskStatus).toBe("blocked");
  });

  it("PATCH .../resolve with alsoUnblockTask: true unblocks the related task via the API", async () => {
    const fixture = await createFixtureOrg(db, { domain: "api-resolve-unblock.test" });
    const task = await insertTask(fixture.org.id, fixture.project.id, "Blocked on approval");
    await db.update(tasks).set({ status: "blocked" }).where(eq(tasks.id, task.id));
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs approval",
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
      method: "PATCH",
      url: `/api/decisions/${decision.id}/resolve`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { resolution: "Approved", alsoUnblockTask: true },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { decision: { status: string }; unblockedTask: { id: string; status: string } | null };
    expect(body.decision.status).toBe("decided");
    expect(body.unblockedTask?.id).toBe(task.id);
    expect(body.unblockedTask?.status).toBe("active");

    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskRow.status).toBe("active");
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

  it("PATCH .../add-info appends the note and returns 400 for a blank one", async () => {
    const fixture = await createFixtureOrg(db, { domain: "api-add-info.test" });
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Needs a call",
      decider: "CEO",
    });

    const app = await buildApp();
    const token = await signSession({
      userId: fixture.user.id,
      organizationId: fixture.org.id,
      email: fixture.user.email,
      role: fixture.authorization.role,
    });

    const blank = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${decision.id}/add-info`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { note: "   " },
    });
    expect(blank.statusCode).toBe(400);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${decision.id}/add-info`,
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { note: "New info from the vendor call." },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { decision: { relevantContext: string | null } };
    expect(body.decision.relevantContext).toContain("New info from the vendor call.");
  });

  it("PATCH .../assign changes the decider and 404s for another organization's decision", async () => {
    const orgA = await createFixtureOrg(db, { domain: "api-assign-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "api-assign-b.test" });

    const decisionA = await createDecision(db, {
      organizationId: orgA.org.id,
      actorId: orgA.user.id,
      title: "Needs an owner",
      decider: "Unassigned",
    });
    const decisionB = await createDecision(db, {
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      title: "Org B decision",
      decider: "Unassigned",
    });

    const app = await buildApp();
    const tokenA = await signSession({
      userId: orgA.user.id,
      organizationId: orgA.org.id,
      email: orgA.user.email,
      role: orgA.authorization.role,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${decisionA.id}/assign`,
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
      payload: { decider: "Sean Meehan, CEO" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { decision: { decider: string } };
    expect(body.decision.decider).toBe("Sean Meehan, CEO");

    const crossOrg = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${decisionB.id}/assign`,
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
      payload: { decider: "Hijacked via API" },
    });
    expect(crossOrg.statusCode).toBe(404);

    await app.close();
  });
});
