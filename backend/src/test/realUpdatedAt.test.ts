import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { initiatives, projects, sources, suggestions, tasks } from "../db/schema.js";
import {
  loadRealUpdatedAt,
  loadRealUpdatedAtForInitiatives,
  loadRealUpdatedAtForObjectives,
  loadRealUpdatedAtForProjects,
  resolveRealUpdatedAt,
} from "../entities/realUpdatedAt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

async function makeSource(organizationId: string, externalId: string, receivedAt: Date) {
  const [source] = await db.insert(sources).values({ organizationId, type: "gmail", externalId, receivedAt }).returning();
  return source;
}

async function makeApprovedSuggestion(
  organizationId: string,
  sourceId: string,
  targetType: "task" | "project" | "initiative" | "objective",
  targetId: string,
) {
  await db.insert(suggestions).values({
    organizationId,
    sourceId,
    targetType,
    targetId,
    changeType: "operational_update",
    proposedDiff: { status: "blocked" },
    reasoning: "test",
    confidence: 0.7,
    status: "approved",
  });
}

describe("loadRealUpdatedAt", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns an empty map for an empty id list", async () => {
    const result = await loadRealUpdatedAt(db, "any-org", "task", []);
    expect(result.size).toBe(0);
  });

  it("resolves the source's receivedAt for a task with one approved suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "real-updated-basic.test" });
    const historicalDate = new Date("2020-07-28T00:00:00.000Z");
    const source = await makeSource(fixture.org.id, "historical-doc", historicalDate);

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "needs_attention" })
      .returning();
    await makeApprovedSuggestion(fixture.org.id, source.id, "task", task.id);

    const result = await loadRealUpdatedAt(db, fixture.org.id, "task", [task.id]);
    expect(result.get(task.id)?.toISOString()).toBe(historicalDate.toISOString());
  });

  it("resolves the MAX receivedAt when several approved suggestions target the same row", async () => {
    const fixture = await createFixtureOrg(db, { domain: "real-updated-max.test" });
    const older = await makeSource(fixture.org.id, "older", new Date("2020-07-28T00:00:00.000Z"));
    const newer = await makeSource(fixture.org.id, "newer", new Date("2024-03-01T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();
    await makeApprovedSuggestion(fixture.org.id, older.id, "task", task.id);
    await makeApprovedSuggestion(fixture.org.id, newer.id, "task", task.id);

    const result = await loadRealUpdatedAt(db, fixture.org.id, "task", [task.id]);
    expect(result.get(task.id)?.toISOString()).toBe(newer.receivedAt.toISOString());
  });

  it("ignores pending and rejected suggestions -- only approved ones count as real evidence", async () => {
    const fixture = await createFixtureOrg(db, { domain: "real-updated-status-filter.test" });
    const source = await makeSource(fixture.org.id, "only-source", new Date("2020-01-01T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();
    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: source.id,
      targetType: "task",
      targetId: task.id,
      changeType: "operational_update",
      proposedDiff: { status: "blocked" },
      reasoning: "test",
      confidence: 0.7,
      status: "pending",
    });

    const result = await loadRealUpdatedAt(db, fixture.org.id, "task", [task.id]);
    expect(result.has(task.id)).toBe(false);
  });

  it("never leaks another organization's evidence dates", async () => {
    const orgA = await createFixtureOrg(db, { domain: "real-updated-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "real-updated-org-b.test" });
    const sourceB = await makeSource(orgB.org.id, "org-b-source", new Date("2020-01-01T00:00:00.000Z"));

    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: orgB.org.id, projectId: orgB.project.id, title: "Org B task", status: "active" })
      .returning();
    await makeApprovedSuggestion(orgB.org.id, sourceB.id, "task", taskB.id);

    // Querying under org A for the same id should find nothing, even though
    // a real approved suggestion exists for it under org B.
    const result = await loadRealUpdatedAt(db, orgA.org.id, "task", [taskB.id]);
    expect(result.has(taskB.id)).toBe(false);
  });
});

describe("resolveRealUpdatedAt", () => {
  it("returns the resolved date when present", () => {
    const fallback = new Date("2026-09-18T00:00:00.000Z");
    const resolved = new Date("2020-07-28T00:00:00.000Z");
    expect(resolveRealUpdatedAt(fallback, resolved)).toBe(resolved);
  });

  it("falls back to the row's own updatedAt when no approved-suggestion evidence exists", () => {
    const fallback = new Date("2026-09-18T00:00:00.000Z");
    expect(resolveRealUpdatedAt(fallback, undefined)).toBe(fallback);
  });
});

// Real production case that exposed the gap: a project with zero suggestions
// ever approved directly against it, but whose own tasks carry real (and, in
// that case, much OLDER) evidence dates -- the project's card must reflect
// that instead of silently falling back to its own creation timestamp as if
// nothing were known about it.
describe("loadRealUpdatedAtForProjects", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("rolls up from a task's real date when the project itself has no direct suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rollup-project-from-task.test" });
    const oldSource = await makeSource(fixture.org.id, "old", new Date("2019-05-22T16:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();
    await makeApprovedSuggestion(fixture.org.id, oldSource.id, "task", task.id);

    const result = await loadRealUpdatedAtForProjects(db, fixture.org.id, [fixture.project.id]);
    expect(result.get(fixture.project.id)?.toISOString()).toBe(oldSource.receivedAt.toISOString());
  });

  it("takes the max of a direct suggestion and a task's own date", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rollup-project-max.test" });
    const older = await makeSource(fixture.org.id, "older", new Date("2019-01-01T00:00:00.000Z"));
    const newer = await makeSource(fixture.org.id, "newer", new Date("2024-01-01T00:00:00.000Z"));

    await makeApprovedSuggestion(fixture.org.id, newer.id, "project", fixture.project.id);
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();
    await makeApprovedSuggestion(fixture.org.id, older.id, "task", task.id);

    const result = await loadRealUpdatedAtForProjects(db, fixture.org.id, [fixture.project.id]);
    expect(result.get(fixture.project.id)?.toISOString()).toBe(newer.receivedAt.toISOString());
  });

  it("returns nothing for a project with no history anywhere in it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rollup-project-empty.test" });
    const result = await loadRealUpdatedAtForProjects(db, fixture.org.id, [fixture.project.id]);
    expect(result.has(fixture.project.id)).toBe(false);
  });
});

describe("loadRealUpdatedAtForInitiatives", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("rolls up through a project it owns, and through that project's own tasks", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rollup-initiative-deep.test" });
    const source = await makeSource(fixture.org.id, "deep-source", new Date("2019-05-22T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();
    await makeApprovedSuggestion(fixture.org.id, source.id, "task", task.id);

    const result = await loadRealUpdatedAtForInitiatives(db, fixture.org.id, [fixture.initiative.id]);
    expect(result.get(fixture.initiative.id)?.toISOString()).toBe(source.receivedAt.toISOString());
  });

  it("also picks up a suggestion made directly on one of its projects (not just tasks)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rollup-initiative-via-project.test" });
    const source = await makeSource(fixture.org.id, "project-source", new Date("2021-03-01T00:00:00.000Z"));
    await makeApprovedSuggestion(fixture.org.id, source.id, "project", fixture.project.id);

    const result = await loadRealUpdatedAtForInitiatives(db, fixture.org.id, [fixture.initiative.id]);
    expect(result.get(fixture.initiative.id)?.toISOString()).toBe(source.receivedAt.toISOString());
  });

  it("never leaks another initiative's project/task evidence", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rollup-initiative-isolated.test" });
    const [otherInitiative] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Other initiative" })
      .returning();
    const [otherProject] = await db
      .insert(projects)
      .values({ organizationId: fixture.org.id, initiativeId: otherInitiative.id, title: "Other project" })
      .returning();
    const source = await makeSource(fixture.org.id, "unrelated", new Date("2019-01-01T00:00:00.000Z"));
    await makeApprovedSuggestion(fixture.org.id, source.id, "project", otherProject.id);

    const result = await loadRealUpdatedAtForInitiatives(db, fixture.org.id, [fixture.initiative.id]);
    expect(result.has(fixture.initiative.id)).toBe(false);
  });
});

describe("loadRealUpdatedAtForObjectives", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("rolls up all the way down from a task three levels below it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rollup-objective-deep.test" });
    const source = await makeSource(fixture.org.id, "deep-source", new Date("2019-05-22T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();
    await makeApprovedSuggestion(fixture.org.id, source.id, "task", task.id);

    const result = await loadRealUpdatedAtForObjectives(db, fixture.org.id, [fixture.objective.id]);
    expect(result.get(fixture.objective.id)?.toISOString()).toBe(source.receivedAt.toISOString());
  });

  it("takes the max across a direct suggestion and a deeply-nested task", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rollup-objective-max.test" });
    const older = await makeSource(fixture.org.id, "older", new Date("2019-01-01T00:00:00.000Z"));
    const newer = await makeSource(fixture.org.id, "newer", new Date("2025-01-01T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();
    await makeApprovedSuggestion(fixture.org.id, older.id, "task", task.id);
    await makeApprovedSuggestion(fixture.org.id, newer.id, "objective", fixture.objective.id);

    const result = await loadRealUpdatedAtForObjectives(db, fixture.org.id, [fixture.objective.id]);
    expect(result.get(fixture.objective.id)?.toISOString()).toBe(newer.receivedAt.toISOString());
  });
});
