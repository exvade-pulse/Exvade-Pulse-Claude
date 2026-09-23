import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, projects, sources, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { setClaudeClientForTesting } from "../interpretation/claudeClient.js";
import { createRelationship } from "../relationships/manage.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

async function tokenFor(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
  return signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: fixture.authorization.role,
  });
}

describe("POST /api/relationships/suggest", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns all zeros when the org has no projects", async () => {
    const fixture = await createFixtureOrg(db, { domain: "relsug-no-projects.test" });
    await db.delete(projects).where(and(eq(projects.id, fixture.project.id), eq(projects.organizationId, fixture.org.id)));

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/relationships/suggest",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projectsChecked: 0, tasksChecked: 0, relationshipsFound: 0 });
  });

  it("skips a project with fewer than two eligible tasks without calling Claude", async () => {
    const fixture = await createFixtureOrg(db, { domain: "relsug-single-task.test" });
    await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Solo task", status: "active" });

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        throw new Error("should not be called -- only one eligible task");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/relationships/suggest",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 0, tasksChecked: 0, relationshipsFound: 0 });
  });

  it("proposes the relationship Claude flags, citing a synthetic manual source", async () => {
    const fixture = await createFixtureOrg(db, { domain: "relsug-happy-path.test" });
    const [taskA] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Calibrate rig", status: "active" })
      .returning();
    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Run DV testing", status: "active" })
      .returning();

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () =>
        toolUseMessage("flag_relationships", {
          relationships: [
            {
              fromType: "task",
              fromId: taskB.id,
              toType: "task",
              toId: taskA.id,
              relationType: "depends_on",
              reasoning: "DV testing waits on calibration.",
              confidence: 0.85,
            },
          ],
        }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/relationships/suggest",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projectsChecked: 1, tasksChecked: 2, relationshipsFound: 1 });

    const suggestionRows = await db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, fixture.org.id), eq(suggestions.targetType, "relationship")));
    expect(suggestionRows).toHaveLength(1);
    expect(suggestionRows[0].targetId).toBeNull();
    expect(suggestionRows[0].proposedDiff).toMatchObject({
      fromType: "task",
      fromId: taskB.id,
      toType: "task",
      toId: taskA.id,
      relationType: "depends_on",
    });
    expect(suggestionRows[0].confidence).toBe(0.85);

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, suggestionRows[0].sourceId));
    expect(sourceRow.type).toBe("manual");
    expect(sourceRow.rawBody).toContain("relationship");
  });

  it("includes the org's open decisions alongside a project's tasks as candidates", async () => {
    const fixture = await createFixtureOrg(db, { domain: "relsug-decision-candidate.test" });
    const [taskA] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Order sensor", status: "active" })
      .returning();
    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Install sensor", status: "active" })
      .returning();
    const [openDecision] = await db
      .insert(decisions)
      .values({ organizationId: fixture.org.id, title: "Choose sensor vendor", decider: "Ops lead", status: "open" })
      .returning();
    await db.insert(decisions).values({
      organizationId: fixture.org.id,
      title: "Already decided thing",
      decider: "Ops lead",
      status: "decided",
    });

    let seenCandidateIds: string[] = [];
    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async (params) => {
        const text = (params.messages[0].content as string) ?? "";
        seenCandidateIds = [taskA.id, taskB.id, openDecision.id].filter((id) => text.includes(id));
        return toolUseMessage("flag_relationships", { relationships: [] });
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/relationships/suggest",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 1, tasksChecked: 2, relationshipsFound: 0 });
    expect(seenCandidateIds.sort()).toEqual([taskA.id, taskB.id, openDecision.id].sort());
  });

  it("does not re-propose a pair that already has a real entity_relationships row", async () => {
    const fixture = await createFixtureOrg(db, { domain: "relsug-existing-real.test" });
    const [taskA] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Calibrate rig", status: "active" })
      .returning();
    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Run DV testing", status: "active" })
      .returning();
    await createRelationship(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      fromType: "task",
      fromId: taskB.id,
      toType: "task",
      toId: taskA.id,
      relationType: "depends_on",
    });

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () =>
        toolUseMessage("flag_relationships", {
          relationships: [
            {
              fromType: "task",
              fromId: taskB.id,
              toType: "task",
              toId: taskA.id,
              relationType: "depends_on",
              reasoning: "Already known, should be filtered.",
              confidence: 0.9,
            },
          ],
        }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/relationships/suggest",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 1, tasksChecked: 2, relationshipsFound: 0 });
  });

  it("does not re-propose a pair that already has a pending relationship suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "relsug-existing-pending.test" });
    const [taskA] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Calibrate rig", status: "active" })
      .returning();
    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Run DV testing", status: "active" })
      .returning();
    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "relationship",
      targetId: null,
      changeType: "relationship",
      proposedDiff: { fromType: "task", fromId: taskB.id, toType: "task", toId: taskA.id, relationType: "depends_on" },
      reasoning: "Already pending.",
      confidence: 0.8,
    });

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () =>
        toolUseMessage("flag_relationships", {
          relationships: [
            {
              fromType: "task",
              fromId: taskB.id,
              toType: "task",
              toId: taskA.id,
              relationType: "depends_on",
              reasoning: "Should be filtered, already pending.",
              confidence: 0.9,
            },
          ],
        }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/relationships/suggest",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 1, tasksChecked: 2, relationshipsFound: 0 });
    const relationshipSuggestions = await db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, fixture.org.id), eq(suggestions.targetType, "relationship")));
    expect(relationshipSuggestions).toHaveLength(1); // still just the pre-seeded one, no duplicate
  });

  it("never checks or flags another organization's tasks or decisions", async () => {
    const orgA = await createFixtureOrg(db, { domain: "relsug-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "relsug-org-b.test" });
    await db.insert(tasks).values([
      { organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B Task A", status: "active" },
      { organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B Task B", status: "active" },
    ]);

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        throw new Error("should not be called -- org A has no eligible tasks of its own");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/relationships/suggest",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 0, tasksChecked: 0, relationshipsFound: 0 });
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/relationships/suggest" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });
});
