import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { initiatives, projects, sources, suggestions, tasks } from "../db/schema.js";
import { approveSuggestion } from "../suggestions/apply.js";
import { supersedeHierarchy } from "../entities/supersedeHierarchy.js";
import { loadCompanyMapTree } from "../routes/companyMap.js";
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

describe("POST /api/tasks/check-duplicates", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns all zeros when the org has no projects", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dup-no-projects.test" });
    await db.delete(projects).where(and(eq(projects.id, fixture.project.id), eq(projects.organizationId, fixture.org.id)));

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/check-duplicates",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projectsChecked: 0, tasksChecked: 0, duplicatesFound: 0, decisionsChecked: 0, decisionDuplicatesFound: 0, hierarchyChecked: 0, hierarchyDuplicatesFound: 0 });
  });

  it("skips a project with fewer than two eligible tasks without calling Claude", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dup-single-task.test" });
    await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Solo task", status: "active" });

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        throw new Error("should not be called -- only one eligible task");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/check-duplicates",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 0, tasksChecked: 0, duplicatesFound: 0, decisionsChecked: 0, decisionDuplicatesFound: 0, hierarchyChecked: 0, hierarchyDuplicatesFound: 0 });
  });

  it("excludes completed/resolved/superseded tasks from both the count and the comparison set", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dup-excluded-status.test" });
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Active task", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Done already", status: "completed" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Resolved already", status: "resolved" },
    ]);

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        throw new Error("should not be called -- only one eligible task remains");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/check-duplicates",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 0, tasksChecked: 0, duplicatesFound: 0, decisionsChecked: 0, decisionDuplicatesFound: 0, hierarchyChecked: 0, hierarchyDuplicatesFound: 0 });
  });

  it("proposes superseding the duplicate task Claude flags, citing a synthetic manual source", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dup-happy-path.test" });
    const [taskA] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Call Biomerics about DV testing", status: "active" })
      .returning();
    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Follow up with Biomerics on DV testing", status: "active" })
      .returning();

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () =>
        toolUseMessage("flag_duplicate_tasks", {
          duplicates: [{ keepTaskId: taskB.id, supersedeTaskId: taskA.id, reasoning: "Same vendor call.", confidence: 0.85 }],
        }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/check-duplicates",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projectsChecked: 1, tasksChecked: 2, duplicatesFound: 1, decisionsChecked: 0, decisionDuplicatesFound: 0, hierarchyChecked: 0, hierarchyDuplicatesFound: 0 });

    const suggestionRows = await db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, fixture.org.id), eq(suggestions.targetId, taskA.id)));
    expect(suggestionRows).toHaveLength(1);
    // A merge proposal: nothing changes until it's approved.
    expect(suggestionRows[0].changeType).toBe("merge");
    expect(suggestionRows[0].proposedDiff).toEqual({ supersededById: taskB.id });
    expect(suggestionRows[0].confidence).toBe(0.85);

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, suggestionRows[0].sourceId));
    expect(sourceRow.type).toBe("manual");
    expect(sourceRow.rawBody).toContain("duplicate");
  });

  it("creates no source row and no suggestions when nothing is found across any project", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dup-nothing-found.test" });
    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task A", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task B", status: "active" },
    ]);

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => toolUseMessage("flag_duplicate_tasks", { duplicates: [] }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/check-duplicates",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 1, tasksChecked: 2, duplicatesFound: 0, decisionsChecked: 0, decisionDuplicatesFound: 0, hierarchyChecked: 0, hierarchyDuplicatesFound: 0 });

    // createFixtureOrg already inserts one default (type "gmail") source as
    // part of org setup -- the assertion is that the route creates no
    // *additional* one (always type "manual"), not that zero sources exist.
    const manualSourceRows = await db
      .select()
      .from(sources)
      .where(and(eq(sources.organizationId, fixture.org.id), eq(sources.type, "manual")));
    expect(manualSourceRows).toHaveLength(0);
  });

  it("checks each eligible project separately, with its own Claude call", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dup-multi-project.test" });
    const [secondProject] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Second project" })
      .returning();

    await db.insert(tasks).values([
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "P1 Task A", status: "active" },
      { organizationId: fixture.org.id, projectId: fixture.project.id, title: "P1 Task B", status: "active" },
      { organizationId: fixture.org.id, projectId: secondProject.id, title: "P2 Task A", status: "active" },
      { organizationId: fixture.org.id, projectId: secondProject.id, title: "P2 Task B", status: "active" },
    ]);

    let callCount = 0;
    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        callCount++;
        return toolUseMessage("flag_duplicate_tasks", { duplicates: [] });
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/check-duplicates",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 2, tasksChecked: 4, duplicatesFound: 0, decisionsChecked: 0, decisionDuplicatesFound: 0, hierarchyChecked: 2, hierarchyDuplicatesFound: 0 });
    // One call per project, plus one comparing the two projects themselves.
    expect(callCount).toBe(3);
  });

  it("never checks or flags another organization's tasks", async () => {
    const orgA = await createFixtureOrg(db, { domain: "dup-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "dup-org-b.test" });
    await db.insert(tasks).values([
      { organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B Task A", status: "active" },
      { organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B Task B", status: "active" },
    ]);

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        throw new Error("should not be called -- org A has no eligible tasks of its own beyond the single fixture default");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/check-duplicates",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toEqual({ projectsChecked: 0, tasksChecked: 0, duplicatesFound: 0, decisionsChecked: 0, decisionDuplicatesFound: 0, hierarchyChecked: 0, hierarchyDuplicatesFound: 0 });
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/tasks/check-duplicates" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });
});

describe("merging duplicate objectives, initiatives and projects", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("flags a duplicate project company-wide, and approving moves its tasks to the one kept and hides it from the map", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dup-project-merge.test" });
    const [otherInitiative] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Other initiative" })
      .returning();
    const [copy] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: otherInitiative.id, title: "Test project (copy)", description: "Rig #3 bench work", owner: "Don" })
      .returning();
    const [movedTask] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: copy.id, title: "Recalibrate rig #3", status: "completed" })
      .returning();

    const prompts: string[] = [];
    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async (params) => {
        const prompt = String(params.messages[0].content);
        prompts.push(prompt);
        return prompt.includes("open projects")
          ? toolUseMessage("flag_duplicate_projects", {
              duplicates: [{ keepId: fixture.project.id, supersedeId: copy.id, reasoning: "Same bench project.", confidence: 0.9 }],
            })
          : toolUseMessage("x", { duplicates: [] });
      },
    });
    const response = await app.inject({ method: "POST", url: "/api/tasks/check-duplicates", cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) } });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.json()).toMatchObject({ hierarchyChecked: 4, hierarchyDuplicatesFound: 1 });
    const projectPrompt = prompts.find((p) => p.includes("open projects"))!;
    expect(projectPrompt).toContain(`title="Test project (copy)" (under initiative: Other initiative) — 1 task`);

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.targetId, copy.id));
    expect(suggestion).toMatchObject({ changeType: "merge", targetType: "project", proposedDiff: { supersededById: fixture.project.id } });

    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id });
    const [merged] = await db.select().from(projects).where(eq(projects.id, copy.id));
    expect(merged).toMatchObject({ status: "superseded", supersededById: fixture.project.id });
    const [kept] = await db.select().from(projects).where(eq(projects.id, fixture.project.id));
    expect(kept.owner).toBe("Don");
    expect(kept.description).toContain('merged from duplicate "Test project (copy)"] Rig #3 bench work');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, movedTask.id));
    expect(task.projectId).toBe(fixture.project.id);

    const tree = await loadCompanyMapTree(fixture.org.id, "admin");
    const projectIds = JSON.stringify(tree);
    expect(projectIds).not.toContain(copy.id);
  });

  it("merging an initiative moves its projects; a merged record can't be kept or merged again", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dup-initiative-merge.test" });
    const [copy] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Initiative copy" })
      .returning();
    const [child] = await db.insert(projects).values({ organizationId: fixture.org.id, initiativeId: copy.id, title: "Child" }).returning();

    const result = await supersedeHierarchy(db, {
      level: "initiative",
      organizationId: fixture.org.id,
      id: copy.id,
      supersededById: fixture.initiative.id,
      actorId: fixture.user.id,
    });
    expect(result.movedChildren).toBe(1);
    const [moved] = await db.select().from(projects).where(eq(projects.id, child.id));
    expect(moved.initiativeId).toBe(fixture.initiative.id);

    const merge = { level: "initiative" as const, organizationId: fixture.org.id, actorId: fixture.user.id };
    await expect(supersedeHierarchy(db, { ...merge, id: copy.id, supersededById: fixture.initiative.id })).rejects.toThrow("already merged");
    await expect(supersedeHierarchy(db, { ...merge, id: fixture.initiative.id, supersededById: copy.id })).rejects.toThrow("merged into another");
    await expect(supersedeHierarchy(db, { ...merge, id: fixture.initiative.id, supersededById: fixture.initiative.id })).rejects.toThrow("itself");
  });

  it("never merges across organizations", async () => {
    const mine = await createFixtureOrg(db, { domain: "dup-hier-mine.test" });
    const theirs = await createFixtureOrg(db, { domain: "dup-hier-theirs.test" });
    await expect(
      supersedeHierarchy(db, { level: "objective", organizationId: mine.org.id, id: mine.objective.id, supersededById: theirs.objective.id, actorId: mine.user.id }),
    ).rejects.toThrow("not found");
  });
});
