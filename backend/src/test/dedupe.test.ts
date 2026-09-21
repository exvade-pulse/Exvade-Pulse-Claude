import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { sources, suggestions, tasks } from "../db/schema.js";
import { mergeOrInsertSuggestion, type ConflictEntry } from "../suggestions/dedupe.js";
import type { SuggestionDraft } from "../interpretation/fakeInterpret.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

function draft(overrides: Partial<Parameters<typeof mergeOrInsertSuggestion>[1]["draft"]> = {}) {
  return {
    changeType: "operational_update" as const,
    targetType: "task" as const,
    targetId: null,
    proposedDiff: {},
    reasoning: "test",
    confidence: 0.7,
    ...overrides,
  };
}

describe("mergeOrInsertSuggestion", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("merges into an existing pending suggestion for the same target, preserving status", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dedupe-merge-pending.test" });
    const [existing] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: fixture.project.id, // any real uuid works as a stand-in target
        changeType: "operational_update",
        proposedDiff: { status: "blocked" },
        reasoning: "Original reason.",
        confidence: 0.6,
        status: "pending",
      })
      .returning();

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      sourceReceivedAt: new Date("2026-02-01"),
      draft: draft({ targetId: existing.targetId, proposedDiff: { latestUpdate: "New info." }, reasoning: "New reason.", confidence: 0.9 }),
    });

    expect(result.merged).toBe(true);
    expect(result.id).toBe(existing.id);

    const [row] = await db.select().from(suggestions).where(eq(suggestions.id, existing.id));
    expect(row.status).toBe("pending");
    expect(row.proposedDiff).toEqual({ status: "blocked", latestUpdate: "New info." });
    expect(row.confidence).toBe(0.9);
  });

  it("merging into an edited suggestion leaves its status as edited, not reset to pending", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dedupe-merge-edited.test" });
    const [existing] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: fixture.project.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked" },
        reasoning: "Original reason.",
        confidence: 0.6,
        status: "edited",
      })
      .returning();

    await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      sourceReceivedAt: new Date(),
      draft: draft({ targetId: existing.targetId, reasoning: "New reason." }),
    });

    const [row] = await db.select().from(suggestions).where(eq(suggestions.id, existing.id));
    expect(row.status).toBe("edited");
  });

  it("does not merge into an already-approved or already-rejected suggestion; inserts a new one instead", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dedupe-no-merge-terminal.test" });
    const [approved] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: fixture.project.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked" },
        reasoning: "Original reason.",
        confidence: 0.6,
        status: "approved",
      })
      .returning();

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      sourceReceivedAt: new Date(),
      draft: draft({ targetId: approved.targetId, reasoning: "Follow-up after approval." }),
    });

    expect(result.merged).toBe(false);
    expect(result.id).not.toBe(approved.id);

    const rows = await db.select().from(suggestions).where(eq(suggestions.targetId, approved.targetId!));
    expect(rows).toHaveLength(2);
  });

  it("never merges across organizations, even for the same targetType/targetId", async () => {
    const orgA = await createFixtureOrg(db, { domain: "dedupe-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "dedupe-org-b.test" });

    const [existingA] = await db
      .insert(suggestions)
      .values({
        organizationId: orgA.org.id,
        sourceId: orgA.source.id,
        targetType: "task",
        targetId: orgA.project.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked" },
        reasoning: "Org A's suggestion.",
        confidence: 0.6,
        status: "pending",
      })
      .returning();

    // Org B proposes an update "targeting" the same id (implausible in
    // practice since ids are real per-org uuids, but the isolation must hold
    // regardless of how the id got there).
    const result = await mergeOrInsertSuggestion(db, {
      organizationId: orgB.org.id,
      sourceId: orgB.source.id,
      sourceReceivedAt: new Date(),
      draft: draft({ targetId: existingA.targetId, reasoning: "Org B's suggestion." }),
    });

    expect(result.merged).toBe(false);

    const [orgARow] = await db.select().from(suggestions).where(eq(suggestions.id, existingA.id));
    expect(orgARow.reasoning).toBe("Org A's suggestion."); // untouched by org B's call
  });

  it("inserts a brand-new row when no pending/edited suggestion exists for that target", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dedupe-insert-fresh.test" });

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      sourceReceivedAt: new Date(),
      draft: draft({ targetType: "task", targetId: null, changeType: "new_task", proposedDiff: { projectId: fixture.project.id, title: "New task" } }),
    });

    expect(result.merged).toBe(false);
    const [row] = await db.select().from(suggestions).where(eq(suggestions.id, result.id));
    expect(row.targetId).toBeNull();
    expect(row.proposedDiff).toEqual({ projectId: fixture.project.id, title: "New task" });
  });
});

async function makeSource(organizationId: string, externalId: string, receivedAt: Date) {
  const [source] = await db.insert(sources).values({ organizationId, type: "gmail", externalId, receivedAt }).returning();
  return source;
}

describe("mergeOrInsertSuggestion conflict detection", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("the named regression case: an older meeting cannot regress a newer confirmed status", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflict-regression.test" });
    const newerSource = await makeSource(fixture.org.id, "newer", new Date("2026-08-15T00:00:00.000Z"));
    const olderSource = await makeSource(fixture.org.id, "older", new Date("2026-08-01T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Task",
        status: "completed",
        fieldEvidence: { status: { asOf: newerSource.receivedAt.toISOString(), sourceId: newerSource.id } },
      })
      .returning();

    const draft: SuggestionDraft = {
      changeType: "operational_update",
      targetType: "task",
      targetId: task.id,
      proposedDiff: { status: "active" },
      reasoning: "Older meeting says this is still active.",
      confidence: 0.7,
    };

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: olderSource.id,
      sourceReceivedAt: olderSource.receivedAt,
      draft,
    });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.id));
    // status was stripped -- the regression never lands in proposedDiff.
    expect(suggestion.proposedDiff).toEqual({});
    const conflicts = suggestion.conflicts as ConflictEntry[];
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      field: "status",
      proposedValue: "active",
      currentValue: "completed",
      currentAsOf: newerSource.receivedAt.toISOString(),
    });
  });

  it("only strips the conflicting field, leaving unrelated fields in the same diff applied normally", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflict-partial.test" });
    const newerSource = await makeSource(fixture.org.id, "newer", new Date("2026-08-15T00:00:00.000Z"));
    const olderSource = await makeSource(fixture.org.id, "older", new Date("2026-08-01T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Task",
        status: "blocked",
        fieldEvidence: { status: { asOf: newerSource.receivedAt.toISOString(), sourceId: newerSource.id } },
      })
      .returning();

    const draft: SuggestionDraft = {
      changeType: "operational_update",
      targetType: "task",
      targetId: task.id,
      proposedDiff: { status: "active", nextAction: "Follow up with vendor" },
      reasoning: "test",
      confidence: 0.7,
    };

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: olderSource.id,
      sourceReceivedAt: olderSource.receivedAt,
      draft,
    });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.id));
    expect(suggestion.proposedDiff).toEqual({ nextAction: "Follow up with vendor" });
    expect((suggestion.conflicts as ConflictEntry[]).map((c) => c.field)).toEqual(["status"]);
  });

  it("does not flag a conflict when the task has no prior evidence for the field", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflict-no-prior-evidence.test" });
    const source = await makeSource(fixture.org.id, "only-source", new Date("2026-08-01T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task", status: "active" })
      .returning();

    const draft: SuggestionDraft = {
      changeType: "operational_update",
      targetType: "task",
      targetId: task.id,
      proposedDiff: { status: "blocked" },
      reasoning: "test",
      confidence: 0.7,
    };

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: source.id,
      sourceReceivedAt: source.receivedAt,
      draft,
    });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.id));
    expect(suggestion.proposedDiff).toEqual({ status: "blocked" });
    expect(suggestion.conflicts).toBeNull();
  });

  it("does not flag a conflict when the new source is as-new-or-newer than the existing evidence", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflict-newer-wins.test" });
    const olderSource = await makeSource(fixture.org.id, "older", new Date("2026-08-01T00:00:00.000Z"));
    const newerSource = await makeSource(fixture.org.id, "newer", new Date("2026-08-15T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Task",
        status: "active",
        fieldEvidence: { status: { asOf: olderSource.receivedAt.toISOString(), sourceId: olderSource.id } },
      })
      .returning();

    const draft: SuggestionDraft = {
      changeType: "operational_update",
      targetType: "task",
      targetId: task.id,
      proposedDiff: { status: "blocked" },
      reasoning: "test",
      confidence: 0.7,
    };

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: newerSource.id,
      sourceReceivedAt: newerSource.receivedAt,
      draft,
    });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.id));
    expect(suggestion.proposedDiff).toEqual({ status: "blocked" });
    expect(suggestion.conflicts).toBeNull();
  });

  it("never checks an untracked field (e.g. title) for conflicts", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflict-untracked-field.test" });
    const source = await makeSource(fixture.org.id, "only-source", new Date("2026-01-01T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Original title",
        status: "active",
        fieldEvidence: { status: { asOf: new Date("2026-08-15T00:00:00.000Z").toISOString(), sourceId: "irrelevant" } },
      })
      .returning();

    const draft: SuggestionDraft = {
      changeType: "context",
      targetType: "task",
      targetId: task.id,
      proposedDiff: { title: "A much older, stale title correction" },
      reasoning: "test",
      confidence: 0.7,
    };

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: source.id,
      sourceReceivedAt: source.receivedAt,
      draft,
    });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.id));
    expect(suggestion.proposedDiff).toEqual({ title: "A much older, stale title correction" });
    expect(suggestion.conflicts).toBeNull();
  });

  it("never runs the conflict check for a brand-new task (targetId null)", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflict-new-task.test" });
    const source = await makeSource(fixture.org.id, "only-source", new Date("2020-01-01T00:00:00.000Z"));

    const draft: SuggestionDraft = {
      changeType: "new_task",
      targetType: "task",
      targetId: null,
      proposedDiff: { projectId: fixture.project.id, title: "New task", status: "active" },
      reasoning: "test",
      confidence: 0.6,
    };

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: source.id,
      sourceReceivedAt: source.receivedAt,
      draft,
    });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.id));
    expect(suggestion.conflicts).toBeNull();
    expect(suggestion.proposedDiff).toEqual({ projectId: fixture.project.id, title: "New task", status: "active" });
  });

  it("merges a fresh conflict into an existing pending suggestion's conflicts, replacing a same-field entry", async () => {
    const fixture = await createFixtureOrg(db, { domain: "conflict-merge-existing.test" });
    const confirmedSource = await makeSource(fixture.org.id, "confirmed", new Date("2026-08-15T00:00:00.000Z"));
    const firstOlderSource = await makeSource(fixture.org.id, "first-older", new Date("2026-08-01T00:00:00.000Z"));
    const secondOlderSource = await makeSource(fixture.org.id, "second-older", new Date("2026-07-01T00:00:00.000Z"));

    const [task] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Task",
        status: "completed",
        fieldEvidence: { status: { asOf: confirmedSource.receivedAt.toISOString(), sourceId: confirmedSource.id } },
      })
      .returning();

    const firstDraft: SuggestionDraft = {
      changeType: "operational_update",
      targetType: "task",
      targetId: task.id,
      proposedDiff: { status: "active" },
      reasoning: "First older report.",
      confidence: 0.6,
    };
    await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: firstOlderSource.id,
      sourceReceivedAt: firstOlderSource.receivedAt,
      draft: firstDraft,
    });

    const secondDraft: SuggestionDraft = {
      changeType: "operational_update",
      targetType: "task",
      targetId: task.id,
      proposedDiff: { status: "blocked" },
      reasoning: "Second, even older report.",
      confidence: 0.5,
    };
    const secondResult = await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: secondOlderSource.id,
      sourceReceivedAt: secondOlderSource.receivedAt,
      draft: secondDraft,
    });

    // Still one suggestion row (merged, not duplicated).
    const allForTask = await db.select().from(suggestions).where(and(eq(suggestions.organizationId, fixture.org.id), eq(suggestions.targetId, task.id)));
    expect(allForTask).toHaveLength(1);

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, secondResult.id));
    const conflicts = suggestion.conflicts as ConflictEntry[];
    expect(conflicts).toHaveLength(1); // same field ("status") replaced, not duplicated
    expect(conflicts[0].proposedValue).toBe("blocked"); // the newer draft's own conflict entry won
    expect(conflicts[0].proposedSourceId).toBe(secondOlderSource.id);
  });

  it("never leaks another organization's task evidence into the conflict check", async () => {
    const orgA = await createFixtureOrg(db, { domain: "conflict-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "conflict-org-b.test" });
    const source = await makeSource(orgA.org.id, "org-a-source", new Date("2020-01-01T00:00:00.000Z"));

    const [taskB] = await db
      .insert(tasks)
      .values({
        organizationId: orgB.org.id,
        projectId: orgB.project.id,
        title: "Org B task",
        status: "completed",
        fieldEvidence: { status: { asOf: new Date("2026-08-15T00:00:00.000Z").toISOString(), sourceId: "irrelevant" } },
      })
      .returning();

    // A draft in org A's own ingestion, whose targetId happens to collide
    // with org B's task id -- the conflict check must org-scope its lookup
    // the same way loadCurrentStates/loadBreadcrumbs already do elsewhere.
    const draft: SuggestionDraft = {
      changeType: "operational_update",
      targetType: "task",
      targetId: taskB.id,
      proposedDiff: { status: "active" },
      reasoning: "test",
      confidence: 0.6,
    };

    const result = await mergeOrInsertSuggestion(db, {
      organizationId: orgA.org.id,
      sourceId: source.id,
      sourceReceivedAt: source.receivedAt,
      draft,
    });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.id));
    // org A's org-scoped lookup finds no such task, so no conflict is possible.
    expect(suggestion.conflicts).toBeNull();
    expect(suggestion.proposedDiff).toEqual({ status: "active" });
  });
});
