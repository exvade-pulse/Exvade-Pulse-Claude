import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, decisions, suggestions, tasks, users } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { canViewVisibility } from "../access/visibility.js";
import { createDecision } from "../decisions/manage.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;

async function adminToken(fixture: Fixture) {
  return signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: "admin",
  });
}

// createFixtureOrg only ever creates one user; visibility enforcement needs
// two roles in the *same* org, so this adds a second, member-role user
// directly rather than via a second createFixtureOrg call (which would
// create a whole separate org).
async function addMember(fixture: Fixture, emailPrefix = "member") {
  const email = `${emailPrefix}-${randomUUID()}@${fixture.org.domain}`;
  const [memberUser] = await db
    .insert(users)
    .values({ organizationId: fixture.org.id, googleId: `google-${email}`, email, name: "Test Member" })
    .returning();
  await db.insert(authorizedUsers).values({ organizationId: fixture.org.id, email, role: "member", invitedBy: null });
  const token = await signSession({
    userId: memberUser.id,
    organizationId: fixture.org.id,
    email: memberUser.email,
    role: "member",
  });
  return { user: memberUser, token };
}

describe("canViewVisibility", () => {
  it("team is visible to any role; leadership/restricted are admin-only", () => {
    expect(canViewVisibility("member", "team")).toBe(true);
    expect(canViewVisibility("admin", "team")).toBe(true);
    expect(canViewVisibility("member", "leadership")).toBe(false);
    expect(canViewVisibility("admin", "leadership")).toBe(true);
    expect(canViewVisibility("member", "restricted")).toBe(false);
    expect(canViewVisibility("admin", "restricted")).toBe(true);
  });
});

describe("task visibility enforcement", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("a restricted task is hidden from a member's needs-attention list but visible to an admin", async () => {
    const fixture = await createFixtureOrg(db, { domain: "vis-task-needs-attention.test" });
    const member = await addMember(fixture);

    const [restrictedTask] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Sensitive HR matter",
        status: "blocked",
        visibility: "restricted",
      })
      .returning();
    await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Ordinary blocked task", status: "blocked" });

    const app = await buildApp();

    const asMember = await app.inject({
      method: "GET",
      url: "/api/dashboard/needs-attention",
      cookies: { [SESSION_COOKIE_NAME]: member.token },
    });
    const memberBody = asMember.json() as { tasks: Array<{ id: string }> };
    expect(memberBody.tasks.map((t) => t.id)).not.toContain(restrictedTask.id);
    expect(memberBody.tasks).toHaveLength(1);

    const asAdmin = await app.inject({
      method: "GET",
      url: "/api/dashboard/needs-attention",
      cookies: { [SESSION_COOKIE_NAME]: await adminToken(fixture) },
    });
    const adminBody = asAdmin.json() as { tasks: Array<{ id: string }> };
    expect(adminBody.tasks.map((t) => t.id)).toContain(restrictedTask.id);
    expect(adminBody.tasks).toHaveLength(2);

    await app.close();
  });

  it("GET /api/tasks/:id 404s for a member on a restricted task, 200s for an admin", async () => {
    const fixture = await createFixtureOrg(db, { domain: "vis-task-detail.test" });
    const member = await addMember(fixture);

    const [restrictedTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Restricted", visibility: "leadership" })
      .returning();

    const app = await buildApp();

    const asMember = await app.inject({
      method: "GET",
      url: `/api/tasks/${restrictedTask.id}`,
      cookies: { [SESSION_COOKIE_NAME]: member.token },
    });
    expect(asMember.statusCode).toBe(404);

    const asAdmin = await app.inject({
      method: "GET",
      url: `/api/tasks/${restrictedTask.id}`,
      cookies: { [SESSION_COOKIE_NAME]: await adminToken(fixture) },
    });
    expect(asAdmin.statusCode).toBe(200);

    await app.close();
  });

  it("PATCH /api/tasks/:id/visibility is admin-only, validates the value, and is org-scoped", async () => {
    const orgA = await createFixtureOrg(db, { domain: "vis-task-patch-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "vis-task-patch-b.test" });
    const memberA = await addMember(orgA);

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: orgA.org.id, projectId: orgA.project.id, title: "Task" })
      .returning();

    const app = await buildApp();

    const asMember = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/visibility`,
      payload: { visibility: "restricted" },
      cookies: { [SESSION_COOKIE_NAME]: memberA.token },
    });
    expect(asMember.statusCode).toBe(403);

    const badValue = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/visibility`,
      payload: { visibility: "top-secret" },
      cookies: { [SESSION_COOKIE_NAME]: await adminToken(orgA) },
    });
    expect(badValue.statusCode).toBe(400);

    const crossOrg = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/visibility`,
      payload: { visibility: "restricted" },
      cookies: { [SESSION_COOKIE_NAME]: await adminToken(orgB) },
    });
    expect(crossOrg.statusCode).toBe(404);

    const asAdmin = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/visibility`,
      payload: { visibility: "restricted" },
      cookies: { [SESSION_COOKIE_NAME]: await adminToken(orgA) },
    });
    expect(asAdmin.statusCode).toBe(200);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.visibility).toBe("restricted");

    await app.close();
  });
});

describe("decision visibility enforcement", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("GET /api/decisions excludes a restricted decision for a member, includes it for an admin", async () => {
    const fixture = await createFixtureOrg(db, { domain: "vis-decision-list.test" });
    const member = await addMember(fixture);

    const restricted = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Sensitive compensation decision",
      decider: "CEO",
    });
    await db.update(decisions).set({ visibility: "restricted" }).where(eq(decisions.id, restricted.id));
    const ordinary = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Ordinary decision",
      decider: "CEO",
    });

    const app = await buildApp();

    const asMember = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: member.token },
    });
    const memberIds = (asMember.json() as { decisions: Array<{ id: string }> }).decisions.map((d) => d.id);
    expect(memberIds).not.toContain(restricted.id);
    expect(memberIds).toContain(ordinary.id);

    const asAdmin = await app.inject({
      method: "GET",
      url: "/api/decisions",
      cookies: { [SESSION_COOKIE_NAME]: await adminToken(fixture) },
    });
    const adminDecisions = (asAdmin.json() as { decisions: Array<{ id: string; visibility: string }> }).decisions;
    expect(adminDecisions.map((d) => d.id)).toContain(restricted.id);
    // Regression check: the list response must actually carry each decision's
    // visibility, not just filter by it -- the admin UI's visibility selector
    // reads this field to show the current value on load.
    expect(adminDecisions.find((d) => d.id === restricted.id)?.visibility).toBe("restricted");

    await app.close();
  });

  it("add-info/assign/resolve all 404 for a member on a restricted decision", async () => {
    const fixture = await createFixtureOrg(db, { domain: "vis-decision-actions.test" });
    const member = await addMember(fixture);

    const restricted = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Restricted decision",
      decider: "CEO",
    });
    await db.update(decisions).set({ visibility: "leadership" }).where(eq(decisions.id, restricted.id));

    const app = await buildApp();
    const cookies = { [SESSION_COOKIE_NAME]: member.token };

    const addInfo = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${restricted.id}/add-info`,
      payload: { note: "trying to sneak a look" },
      cookies,
    });
    expect(addInfo.statusCode).toBe(404);

    const assign = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${restricted.id}/assign`,
      payload: { decider: "Someone else" },
      cookies,
    });
    expect(assign.statusCode).toBe(404);

    const resolve = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${restricted.id}/resolve`,
      payload: { resolution: "Decided without leadership" },
      cookies,
    });
    expect(resolve.statusCode).toBe(404);

    // Untouched -- none of the member's attempts should have gone through.
    const [row] = await db.select().from(decisions).where(eq(decisions.id, restricted.id));
    expect(row.status).toBe("open");
    expect(row.decider).toBe("CEO");

    await app.close();
  });

  it("PATCH /api/decisions/:id/visibility is admin-only", async () => {
    const fixture = await createFixtureOrg(db, { domain: "vis-decision-patch.test" });
    const member = await addMember(fixture);
    const decision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Decision",
      decider: "CEO",
    });

    const app = await buildApp();

    const asMember = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${decision.id}/visibility`,
      payload: { visibility: "restricted" },
      cookies: { [SESSION_COOKIE_NAME]: member.token },
    });
    expect(asMember.statusCode).toBe(403);

    const asAdmin = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${decision.id}/visibility`,
      payload: { visibility: "restricted" },
      cookies: { [SESSION_COOKIE_NAME]: await adminToken(fixture) },
    });
    expect(asAdmin.statusCode).toBe(200);

    await app.close();
  });
});

describe("visibility enforcement in search and the suggestion review queue", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("GET /api/search excludes a restricted task and decision for a member", async () => {
    const fixture = await createFixtureOrg(db, { domain: "vis-search.test" });
    const member = await addMember(fixture);

    await db.insert(tasks).values({
      organizationId: fixture.org.id,
      projectId: fixture.project.id,
      title: "Confidential layoff planning",
      visibility: "restricted",
    });
    const restrictedDecision = await createDecision(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      title: "Confidential layoff decision",
      decider: "CEO",
    });
    await db.update(decisions).set({ visibility: "restricted" }).where(eq(decisions.id, restrictedDecision.id));

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/search?q=confidential",
      cookies: { [SESSION_COOKIE_NAME]: member.token },
    });
    const body = response.json() as { tasks: unknown[]; decisions: unknown[] };
    expect(body.tasks).toEqual([]);
    expect(body.decisions).toEqual([]);

    await app.close();
  });

  it("GET /api/suggestions hides a suggestion targeting a restricted task from a member, and approve 404s for it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "vis-suggestions.test" });
    const member = await addMember(fixture);

    const [restrictedTask] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Restricted task",
        visibility: "restricted",
      })
      .returning();

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: restrictedTask.id,
        changeType: "operational_update",
        proposedDiff: { latestUpdate: "Some sensitive update" },
        reasoning: "test",
        confidence: 0.7,
      })
      .returning();

    const app = await buildApp();

    const list = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: member.token },
    });
    const listBody = list.json() as { suggestions: Array<{ id: string }> };
    expect(listBody.suggestions.map((s) => s.id)).not.toContain(suggestion.id);

    const approve = await app.inject({
      method: "POST",
      url: `/api/suggestions/${suggestion.id}/approve`,
      cookies: { [SESSION_COOKIE_NAME]: member.token },
    });
    expect(approve.statusCode).toBe(404);

    // An admin sees it and can approve it normally.
    const adminList = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await adminToken(fixture) },
    });
    const adminBody = adminList.json() as { suggestions: Array<{ id: string }> };
    expect(adminBody.suggestions.map((s) => s.id)).toContain(suggestion.id);

    await app.close();
  });
});
