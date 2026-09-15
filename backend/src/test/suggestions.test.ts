import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, suggestions, tasks } from "../db/schema.js";
import { approveSuggestion, rejectSuggestion, SuggestionApplyError } from "../suggestions/apply.js";

const { db, client } = testDb();

describe("suggestion approval", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await client.end();
  });

  it("approving a new_task suggestion creates the task and writes an audit_log entry", async () => {
    const fixture = await createFixtureOrg(db, { domain: "approve-flow.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: {
          projectId: fixture.project.id,
          title: "Check wiring harness on rig #3",
          nextAction: "Inspect wiring before next run",
        },
        reasoning: "No existing open task matches this report.",
        confidence: 0.6,
      })
      .returning();

    const updated = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(updated.status).toBe("approved");
    expect(updated.reviewedBy).toBe(fixture.user.id);
    expect(updated.targetId).not.toBeNull();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, updated.targetId!));
    expect(task).toBeDefined();
    expect(task.title).toBe("Check wiring harness on rig #3");
    expect(task.projectId).toBe(fixture.project.id);
    expect(task.status).toBe("active");

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, task.id));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("suggestion.approved");
    expect(auditRows[0].actorId).toBe(fixture.user.id);
  });

  it("approving an update suggestion (targetId set) mutates the existing task, not a new one", async () => {
    const fixture = await createFixtureOrg(db, { domain: "update-flow.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Original title",
        status: "active",
      })
      .returning();

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: existingTask.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked", latestUpdate: "Waiting on part shipment." },
        reasoning: "Email reports a blocker on this exact task.",
        confidence: 0.8,
      })
      .returning();

    const updated = await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(updated.targetId).toBe(existingTask.id);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, existingTask.id));
    expect(task.status).toBe("blocked");
    expect(task.latestUpdate).toBe("Waiting on part shipment.");
    expect(task.title).toBe("Original title"); // untouched field stays as-is

    const allTasks = await db.select().from(tasks).where(eq(tasks.organizationId, fixture.org.id));
    expect(allTasks).toHaveLength(1); // no new task was created
  });

  it("rejecting a suggestion marks it rejected and never touches the target tables", async () => {
    const fixture = await createFixtureOrg(db, { domain: "reject-flow.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Should never be created" },
        reasoning: "test",
        confidence: 0.3,
      })
      .returning();

    const updated = await rejectSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    expect(updated.status).toBe("rejected");

    const allTasks = await db.select().from(tasks).where(eq(tasks.organizationId, fixture.org.id));
    expect(allTasks).toHaveLength(0);
  });

  it("cannot approve an already-approved suggestion again", async () => {
    const fixture = await createFixtureOrg(db, { domain: "double-approve.test" });

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Once" },
        reasoning: "test",
        confidence: 0.5,
      })
      .returning();

    await approveSuggestion(db, {
      organizationId: fixture.org.id,
      suggestionId: suggestion.id,
      reviewerId: fixture.user.id,
    });

    await expect(
      approveSuggestion(db, {
        organizationId: fixture.org.id,
        suggestionId: suggestion.id,
        reviewerId: fixture.user.id,
      }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);
  });
});
