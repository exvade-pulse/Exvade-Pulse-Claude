import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { suggestions } from "../db/schema.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";

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
