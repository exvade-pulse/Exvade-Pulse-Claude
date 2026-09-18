import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { projects, sources, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";

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

async function makeUnsortedProject(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
  const [unsorted] = await db
    .insert(projects)
    .values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Unsorted / Needs Triage" })
    .returning();
  return unsorted;
}

describe("GET /api/unsorted", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns project null and an empty task list when no Unsorted project exists yet", async () => {
    const fixture = await createFixtureOrg(db, { domain: "unsorted-none.test" });
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/unsorted",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ project: null, tasks: [] });
  });

  it("lists tasks under the Unsorted project, excluding tasks that belong to other projects", async () => {
    const fixture = await createFixtureOrg(db, { domain: "unsorted-list.test" });
    const unsorted = await makeUnsortedProject(fixture);

    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: unsorted.id, title: "Order replacement sensor harness", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task in the real project", status: "active" },
    ]);

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/unsorted",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    const body = response.json() as { project: { id: string }; tasks: Array<{ title: string; pendingSuggestion: unknown }> };
    expect(body.project.id).toBe(unsorted.id);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].title).toBe("Order replacement sensor harness");
    expect(body.tasks[0].pendingSuggestion).toBeNull();
  });

  it("flags a task that already has a pending suggestion against it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "unsorted-pending.test" });
    const unsorted = await makeUnsortedProject(fixture);

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: unsorted.id, title: "Needs a real home", status: "active" })
      .returning();

    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "task",
      targetId: task.id,
      changeType: "operational_update",
      proposedDiff: { projectId: fixture.project.id },
      reasoning: "test",
      confidence: 0.7,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/unsorted",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    const body = response.json() as { tasks: Array<{ pendingSuggestion: { confidence: number } | null }> };
    expect(body.tasks[0].pendingSuggestion).toEqual({ confidence: 0.7 });
  });

  it("never leaks another organization's Unsorted tasks", async () => {
    const orgA = await createFixtureOrg(db, { domain: "unsorted-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "unsorted-org-b.test" });
    await makeUnsortedProject(orgA);
    const unsortedB = await makeUnsortedProject(orgB);
    await db.insert(tasks).values({ organizationId: orgB.org.id, projectId: unsortedB.id, title: "Org B's task", status: "active" });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/unsorted",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    const body = response.json() as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
  });
});

describe("POST /api/unsorted/retriage", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns zero/zero when no Unsorted project exists", async () => {
    const fixture = await createFixtureOrg(db, { domain: "retriage-none.test" });
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/unsorted/retriage",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ checked: 0, suggested: 0 });
  });

  it("returns zero/zero when the Unsorted project has no tasks", async () => {
    const fixture = await createFixtureOrg(db, { domain: "retriage-empty.test" });
    await makeUnsortedProject(fixture);

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/unsorted/retriage",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.json()).toEqual({ checked: 0, suggested: 0 });
  });

  it("returns zero/zero when no real projects exist yet to re-file into (only Unsorted itself)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "retriage-no-candidates.test" });
    // Delete the fixture's own "Test project" so Unsorted is the only project.
    await db.delete(projects).where(and(eq(projects.id, fixture.project.id), eq(projects.organizationId, fixture.org.id)));
    const unsorted = await makeUnsortedProject(fixture);
    await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: unsorted.id, title: "Stuck with nowhere to go", status: "active" });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/unsorted/retriage",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.json()).toEqual({ checked: 0, suggested: 0 });
  });

  it("excludes completed/resolved/superseded tasks from the check", async () => {
    const fixture = await createFixtureOrg(db, { domain: "retriage-excluded-status.test" });
    const unsorted = await makeUnsortedProject(fixture);
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: unsorted.id, title: "Done already", status: "completed" },
      { organizationId: fixture.org.id, projectId: unsorted.id, title: "Resolved already", status: "resolved" },
    ]);

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        throw new Error("should not be called -- nothing eligible");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/unsorted/retriage",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ checked: 0, suggested: 0 });
  });

  it("creates a suggestion moving a task to the project Claude picks, citing a synthetic manual source", async () => {
    const fixture = await createFixtureOrg(db, { domain: "retriage-happy-path.test" });
    const unsorted = await makeUnsortedProject(fixture);
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: unsorted.id, title: "Order replacement sensor harness", status: "active" })
      .returning();

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () =>
        toolUseMessage("reclassify_task", {
          projectId: fixture.project.id,
          reasoning: "Matches the real project's scope.",
          confidence: 0.82,
        }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/unsorted/retriage",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ checked: 1, suggested: 1 });

    const suggestionRows = await db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, fixture.org.id), eq(suggestions.targetId, task.id)));
    expect(suggestionRows).toHaveLength(1);
    expect(suggestionRows[0].targetType).toBe("task");
    expect(suggestionRows[0].changeType).toBe("operational_update");
    expect(suggestionRows[0].proposedDiff).toEqual({ projectId: fixture.project.id });
    expect(suggestionRows[0].confidence).toBe(0.82);
    expect(suggestionRows[0].status).toBe("pending");

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, suggestionRows[0].sourceId));
    expect(sourceRow.type).toBe("manual");
    expect(sourceRow.rawBody).toContain("re-triage");
  });

  it("creates no suggestion when Claude declines to propose a match", async () => {
    const fixture = await createFixtureOrg(db, { domain: "retriage-no-match.test" });
    const unsorted = await makeUnsortedProject(fixture);
    await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: unsorted.id, title: "Genuinely unrelated to anything", status: "active" });

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => toolUseMessage("reclassify_task", { projectId: null, reasoning: "No match.", confidence: 0 }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/unsorted/retriage",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ checked: 1, suggested: 0 });
    const suggestionRows = await db.select().from(suggestions).where(eq(suggestions.organizationId, fixture.org.id));
    expect(suggestionRows).toHaveLength(0);
  });

  it("running twice merges into the same pending suggestion instead of duplicating it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "retriage-repeat.test" });
    const unsorted = await makeUnsortedProject(fixture);
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: unsorted.id, title: "Order replacement sensor harness", status: "active" })
      .returning();

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () =>
        toolUseMessage("reclassify_task", { projectId: fixture.project.id, reasoning: "Matches.", confidence: 0.7 }),
    });

    const cookies = { [SESSION_COOKIE_NAME]: await tokenFor(fixture) };
    await app.inject({ method: "POST", url: "/api/unsorted/retriage", cookies });
    await app.inject({ method: "POST", url: "/api/unsorted/retriage", cookies });
    setClaudeClientForTesting(undefined);
    await app.close();

    const suggestionRows = await db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, fixture.org.id), eq(suggestions.targetId, task.id)));
    expect(suggestionRows).toHaveLength(1);
  });

  it("never checks or re-files another organization's Unsorted tasks", async () => {
    const orgA = await createFixtureOrg(db, { domain: "retriage-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "retriage-org-b.test" });
    await makeUnsortedProject(orgA);
    const unsortedB = await makeUnsortedProject(orgB);
    await db.insert(tasks).values({ organizationId: orgB.org.id, projectId: unsortedB.id, title: "Org B's task", status: "active" });

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        throw new Error("should not be called -- org A has no eligible tasks");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/unsorted/retriage",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ checked: 0, suggested: 0 });
  });
});
