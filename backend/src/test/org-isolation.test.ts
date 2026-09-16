import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { suggestions } from "../db/schema.js";
import { approveSuggestion, editSuggestion, rejectSuggestion, SuggestionApplyError } from "../suggestions/apply.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

async function tokenFor(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
  return signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: fixture.authorization.role,
  });
}

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

describe("organization isolation", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("cannot approve a suggestion using another organization's id", async () => {
    const orgA = await createFixtureOrg(db, { domain: "org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "org-b.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgA.project.id, title: "Org A only" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    await expect(
      approveSuggestion(db, {
        organizationId: orgB.org.id, // wrong org
        suggestionId: suggestion.id,
        reviewerId: orgB.user.id,
      }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);
  });

  it("cannot edit a suggestion using another organization's id", async () => {
    const orgA = await createFixtureOrg(db, { domain: "edit-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "edit-org-b.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgA.project.id, title: "Org A only" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    await expect(
      editSuggestion(db, {
        organizationId: orgB.org.id, // wrong org
        suggestionId: suggestion.id,
        actorId: orgB.user.id,
        diff: { title: "Hijacked" },
      }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);
  });

  it("rejects unauthenticated API requests", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/suggestions" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("a logged-in user only sees and can only act on their own organization's suggestions via the API", async () => {
    const orgA = await createFixtureOrg(db, { domain: "api-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "api-org-b.test" });

    const [suggestionA] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgA.project.id, title: "Belongs to org A" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    const [suggestionB] = await db
      .insert(suggestions)
      .values({
        organizationId: orgB.org.id,
        sourceId: orgB.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgB.project.id, title: "Belongs to org B" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    const app = await buildApp();
    const tokenA = await signSession({
      userId: orgA.user.id,
      organizationId: orgA.org.id,
      email: orgA.user.email,
      role: orgA.authorization.role,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { suggestions: Array<{ id: string }> };
    const ids = body.suggestions.map((s) => s.id);
    expect(ids).toContain(suggestionA.id);
    expect(ids).not.toContain(suggestionB.id);

    const crossOrgApprove = await app.inject({
      method: "POST",
      url: `/api/suggestions/${suggestionB.id}/approve`,
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
    });
    expect(crossOrgApprove.statusCode).toBe(409);

    const crossOrgEdit = await app.inject({
      method: "PATCH",
      url: `/api/suggestions/${suggestionB.id}`,
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
      payload: { proposedDiff: { title: "Hijacked via API" } },
    });
    expect(crossOrgEdit.statusCode).toBe(409);

    await app.close();
  });
});

describe("GET /api/suggestions status filtering", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request with an explicit status", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/suggestions?status=approved" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("?status=approved returns only approved suggestions for the caller's org", async () => {
    const orgA = await createFixtureOrg(db, { domain: "status-approved-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "status-approved-b.test" });

    const [pendingOne] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgA.project.id, title: "Still pending" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    const [rejectedOne] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgA.project.id, title: "Rejected one" },
        reasoning: "test",
        confidence: 0.4,
      })
      .returning();
    await rejectSuggestion(db, { organizationId: orgA.org.id, suggestionId: rejectedOne.id, reviewerId: orgA.user.id });

    const [approvedA] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgA.project.id, title: "Approved in org A" },
        reasoning: "test",
        confidence: 0.9,
      })
      .returning();
    await approveSuggestion(db, { organizationId: orgA.org.id, suggestionId: approvedA.id, reviewerId: orgA.user.id });

    const [approvedB] = await db
      .insert(suggestions)
      .values({
        organizationId: orgB.org.id,
        sourceId: orgB.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgB.project.id, title: "Approved in org B" },
        reasoning: "test",
        confidence: 0.9,
      })
      .returning();
    await approveSuggestion(db, { organizationId: orgB.org.id, suggestionId: approvedB.id, reviewerId: orgB.user.id });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions?status=approved",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      suggestions: Array<{ id: string; status: string; reviewedAt: string | null; reviewerName: string | null; reviewerEmail: string | null }>;
    };
    expect(body.suggestions).toHaveLength(1);
    const [only] = body.suggestions;
    expect(only.id).toBe(approvedA.id);
    expect(only.status).toBe("approved");
    expect(only.reviewedAt).not.toBeNull();
    expect(only.reviewerName).toBe(orgA.user.name);
    expect(only.reviewerEmail).toBe(orgA.user.email);

    const ids = body.suggestions.map((s) => s.id);
    expect(ids).not.toContain(pendingOne.id);
    expect(ids).not.toContain(rejectedOne.id);
    expect(ids).not.toContain(approvedB.id);
  });

  it("?status=rejected returns only rejected suggestions for the caller's org", async () => {
    const orgA = await createFixtureOrg(db, { domain: "status-rejected-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "status-rejected-b.test" });

    const [approvedOne] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgA.project.id, title: "Approved one" },
        reasoning: "test",
        confidence: 0.9,
      })
      .returning();
    await approveSuggestion(db, { organizationId: orgA.org.id, suggestionId: approvedOne.id, reviewerId: orgA.user.id });

    const [rejectedA] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgA.project.id, title: "Rejected in org A" },
        reasoning: "test",
        confidence: 0.2,
      })
      .returning();
    await rejectSuggestion(db, { organizationId: orgA.org.id, suggestionId: rejectedA.id, reviewerId: orgA.user.id });

    const [rejectedB] = await db
      .insert(suggestions)
      .values({
        organizationId: orgB.org.id,
        sourceId: orgB.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: orgB.project.id, title: "Rejected in org B" },
        reasoning: "test",
        confidence: 0.2,
      })
      .returning();
    await rejectSuggestion(db, { organizationId: orgB.org.id, suggestionId: rejectedB.id, reviewerId: orgB.user.id });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions?status=rejected",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { suggestions: Array<{ id: string; status: string }> };
    const ids = body.suggestions.map((s) => s.id);
    expect(ids).toEqual([rejectedA.id]);
    expect(ids).not.toContain(approvedOne.id);
    expect(ids).not.toContain(rejectedB.id);
  });

  it("no status param still defaults to pending + edited only (regression)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "status-default.test" });

    const [pending] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Pending" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    const [toEdit] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Will be edited" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();
    await editSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: toEdit.id,
      actorId: fixture.user.id,
      diff: { title: "Edited title" },
    });

    const [approved] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Approved" },
        reasoning: "test",
        confidence: 0.9,
      })
      .returning();
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: approved.id, reviewerId: fixture.user.id });

    const [rejected] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Rejected" },
        reasoning: "test",
        confidence: 0.2,
      })
      .returning();
    await rejectSuggestion(db, { organizationId: fixture.org.id, suggestionId: rejected.id, reviewerId: fixture.user.id });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/suggestions",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { suggestions: Array<{ id: string; status: string }> };
    const ids = body.suggestions.map((s) => s.id);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(toEdit.id);
    expect(ids).not.toContain(approved.id);
    expect(ids).not.toContain(rejected.id);
  });
});
