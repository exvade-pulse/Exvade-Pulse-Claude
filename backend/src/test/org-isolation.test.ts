import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { suggestions } from "../db/schema.js";
import { approveSuggestion, editSuggestion, SuggestionApplyError } from "../suggestions/apply.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

describe("organization isolation", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await client.end();
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
