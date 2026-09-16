import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, authorizedUsers, decisions, users } from "../db/schema.js";
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

describe("GET /api/activity", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/activity" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("returns only the caller's organization's entries, newest first", async () => {
    const orgA = await createFixtureOrg(db, { domain: "activity-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "activity-org-b.test" });

    const older = new Date(Date.now() - 60_000);
    const newer = new Date();

    const [olderEntry] = await db
      .insert(auditLog)
      .values({
        organizationId: orgA.org.id,
        actorId: orgA.user.id,
        action: "decision.created",
        entityType: "decision",
        entityId: randomUUID(),
        details: { title: "Older" },
        createdAt: older,
      })
      .returning();

    const [newerEntry] = await db
      .insert(auditLog)
      .values({
        organizationId: orgA.org.id,
        actorId: orgA.user.id,
        action: "decision.resolved",
        entityType: "decision",
        entityId: randomUUID(),
        details: { resolution: "Newer" },
        createdAt: newer,
      })
      .returning();

    await db.insert(auditLog).values({
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      action: "decision.created",
      entityType: "decision",
      entityId: randomUUID(),
      details: { title: "Belongs to org B" },
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: Array<{ id: string; action: string }> };
    const ids = body.entries.map((e) => e.id);
    expect(ids).toContain(olderEntry.id);
    expect(ids).toContain(newerEntry.id);
    expect(ids).toHaveLength(2);
    expect(body.entries[0].id).toBe(newerEntry.id);
    expect(body.entries[1].id).toBe(olderEntry.id);
  });

  it("joins the actor's name and email when actorId is set, and handles a null actorId gracefully", async () => {
    const fixture = await createFixtureOrg(db, { domain: "activity-actor.test" });

    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "suggestion.approved",
      entityType: "task",
      entityId: randomUUID(),
      details: {},
    });

    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: null,
      action: "user.authorized",
      entityType: "authorized_user",
      entityId: null,
      details: { email: "someone@activity-actor.test" },
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      entries: Array<{ action: string; actorName: string | null; actorEmail: string | null; entityId: string | null }>;
    };
    expect(body.entries).toHaveLength(2);

    const withActor = body.entries.find((e) => e.action === "suggestion.approved");
    expect(withActor?.actorName).toBe(fixture.user.name);
    expect(withActor?.actorEmail).toBe(fixture.user.email);

    const withoutActor = body.entries.find((e) => e.action === "user.authorized");
    expect(withoutActor?.actorName).toBeNull();
    expect(withoutActor?.actorEmail).toBeNull();
    expect(withoutActor?.entityId).toBeNull();
  });
});

interface ActivityResponseBody {
  entries: Array<{ id: string; action: string }>;
  previousLastActivityViewAt: string | null;
  summary: {
    statusMoves: number;
    completions: number;
    newDecisions: number;
    openDecisionsCount: number;
    mostUrgentOpenDecision: { id: string; title: string } | null;
  };
}

async function addUser(orgId: string, email: string) {
  const [user] = await db
    .insert(users)
    .values({ organizationId: orgId, googleId: `google-${email}`, email, name: email })
    .returning();
  const [authorization] = await db
    .insert(authorizedUsers)
    .values({ organizationId: orgId, email, role: "admin", invitedBy: null })
    .returning();
  return { user, authorization };
}

async function tokenForUser(orgId: string, user: { id: string; email: string }, role: "member" | "admin") {
  return signSession({ userId: user.id, organizationId: orgId, email: user.email, role });
}

describe("GET /api/activity -- what changed since last visit", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("a brand-new user (lastActivityViewAt never set) gets a sensible response, not a crash", async () => {
    const fixture = await createFixtureOrg(db, { domain: "first-visit.test" });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as ActivityResponseBody;
    expect(body.previousLastActivityViewAt).toBeNull();
    expect(body.summary.statusMoves).toBe(0);
    expect(body.summary.completions).toBe(0);
    expect(body.summary.newDecisions).toBe(0);
    expect(body.summary.openDecisionsCount).toBe(0);
    expect(body.summary.mostUrgentOpenDecision).toBeNull();

    const [row] = await db.select({ lastActivityViewAt: users.lastActivityViewAt }).from(users).where(eq(users.id, fixture.user.id));
    expect(row.lastActivityViewAt).not.toBeNull();
  });

  it("a second visit scopes 'since last visit' to entries after the previous visit, and advances the stored timestamp", async () => {
    const fixture = await createFixtureOrg(db, { domain: "second-visit.test" });

    const previousVisit = new Date(Date.now() - 60 * 60 * 1000);
    await db.update(users).set({ lastActivityViewAt: previousVisit }).where(eq(users.id, fixture.user.id));

    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "decision.created",
      entityType: "decision",
      entityId: randomUUID(),
      details: { title: "Before the previous visit -- should not count" },
      createdAt: new Date(previousVisit.getTime() - 60_000),
    });
    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "decision.created",
      entityType: "decision",
      entityId: randomUUID(),
      details: { title: "After the previous visit -- should count" },
      createdAt: new Date(previousVisit.getTime() + 60_000),
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as ActivityResponseBody;
    expect(body.previousLastActivityViewAt).toBe(previousVisit.toISOString());
    expect(body.summary.newDecisions).toBe(1);

    const [row] = await db.select({ lastActivityViewAt: users.lastActivityViewAt }).from(users).where(eq(users.id, fixture.user.id));
    expect(row.lastActivityViewAt).not.toBeNull();
    expect(row.lastActivityViewAt!.getTime()).toBeGreaterThan(previousVisit.getTime());
  });

  it("counts status-move and completion suggestion.approved entries correctly, ignoring ones with no status key", async () => {
    const fixture = await createFixtureOrg(db, { domain: "status-moves.test" });
    const previousVisit = new Date(Date.now() - 60 * 60 * 1000);
    await db.update(users).set({ lastActivityViewAt: previousVisit }).where(eq(users.id, fixture.user.id));

    const after = new Date(previousVisit.getTime() + 1000);

    // Status move + completion.
    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "suggestion.approved",
      entityType: "task",
      entityId: randomUUID(),
      details: { suggestionId: randomUUID(), appliedFields: { status: "completed", latestUpdate: "Shipped" } },
      createdAt: after,
    });
    // Status move + completion (resolved).
    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "suggestion.approved",
      entityType: "task",
      entityId: randomUUID(),
      details: { suggestionId: randomUUID(), appliedFields: { status: "resolved" } },
      createdAt: after,
    });
    // Status move, not a completion.
    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "suggestion.approved",
      entityType: "task",
      entityId: randomUUID(),
      details: { suggestionId: randomUUID(), appliedFields: { status: "blocked" } },
      createdAt: after,
    });
    // No status key at all -- not a status move.
    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "suggestion.approved",
      entityType: "task",
      entityId: randomUUID(),
      details: { suggestionId: randomUUID(), appliedFields: { latestUpdate: "Just an update" } },
      createdAt: after,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as ActivityResponseBody;
    expect(body.summary.statusMoves).toBe(3);
    expect(body.summary.completions).toBe(2);
  });

  it("open-decisions count and most-urgent selection match GET /api/decisions's own ordering (soonest due date first, nulls last)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "urgent-decision.test" });

    const [noDueDate] = await db
      .insert(decisions)
      .values({ organizationId: fixture.org.id, title: "No due date", decider: "Someone" })
      .returning();
    const [soon] = await db
      .insert(decisions)
      .values({ organizationId: fixture.org.id, title: "Due soon", decider: "Someone", dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      .returning();
    const [later] = await db
      .insert(decisions)
      .values({ organizationId: fixture.org.id, title: "Due later", decider: "Someone", dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
      .returning();
    // Already decided -- must not count as open.
    await db
      .insert(decisions)
      .values({
        organizationId: fixture.org.id,
        title: "Already decided",
        decider: "Someone",
        status: "decided",
        resolution: "Done",
        decidedAt: new Date(),
      });

    const app = await buildApp();
    const decisionsResponse = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    const activityResponse = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    const decisionsBody = decisionsResponse.json() as { decisions: Array<{ id: string }> };
    expect(decisionsBody.decisions.map((d) => d.id)).toEqual([soon.id, later.id, noDueDate.id]);

    const body = activityResponse.json() as ActivityResponseBody;
    expect(body.summary.openDecisionsCount).toBe(3);
    expect(body.summary.mostUrgentOpenDecision).toEqual({ id: soon.id, title: soon.title });
  });

  it("two users in the same org each get their own 'since my last visit' scoping", async () => {
    const fixture = await createFixtureOrg(db, { domain: "per-user-isolation.test" });
    const { user: userB } = await addUser(fixture.org.id, "second@per-user-isolation.test");

    const userAPreviousVisit = new Date(Date.now() - 60 * 60 * 1000);
    const userBPreviousVisit = new Date(Date.now() - 5 * 60 * 1000);
    await db.update(users).set({ lastActivityViewAt: userAPreviousVisit }).where(eq(users.id, fixture.user.id));
    await db.update(users).set({ lastActivityViewAt: userBPreviousVisit }).where(eq(users.id, userB.id));

    // Falls between the two visits: new since A's last visit, not since B's.
    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "decision.created",
      entityType: "decision",
      entityId: randomUUID(),
      details: { title: "Between the two visits" },
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    const app = await buildApp();
    const responseA = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    const responseB = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenForUser(fixture.org.id, userB, "admin") },
    });
    await app.close();

    const bodyA = responseA.json() as ActivityResponseBody;
    const bodyB = responseB.json() as ActivityResponseBody;

    expect(bodyA.previousLastActivityViewAt).toBe(userAPreviousVisit.toISOString());
    expect(bodyB.previousLastActivityViewAt).toBe(userBPreviousVisit.toISOString());
    expect(bodyA.summary.newDecisions).toBe(1);
    expect(bodyB.summary.newDecisions).toBe(0);

    const [rowA] = await db.select({ lastActivityViewAt: users.lastActivityViewAt }).from(users).where(eq(users.id, fixture.user.id));
    const [rowB] = await db.select({ lastActivityViewAt: users.lastActivityViewAt }).from(users).where(eq(users.id, userB.id));
    expect(rowA.lastActivityViewAt!.getTime()).toBeGreaterThan(userAPreviousVisit.getTime());
    expect(rowB.lastActivityViewAt!.getTime()).toBeGreaterThan(userBPreviousVisit.getTime());
  });

  it("only counts and reflects the caller's own organization's decisions and audit_log entries", async () => {
    const orgA = await createFixtureOrg(db, { domain: "summary-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "summary-org-b.test" });

    await db.insert(decisions).values({ organizationId: orgB.org.id, title: "Belongs to org B", decider: "Someone" });
    await db.insert(auditLog).values({
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      action: "decision.created",
      entityType: "decision",
      entityId: randomUUID(),
      details: { title: "Belongs to org B" },
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as ActivityResponseBody;
    expect(body.summary.openDecisionsCount).toBe(0);
    expect(body.summary.mostUrgentOpenDecision).toBeNull();
    expect(body.summary.newDecisions).toBe(0);
  });
});
