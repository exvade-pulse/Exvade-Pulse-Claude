import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { sources, suggestions, tasks } from "../db/schema.js";
import { approveSuggestion, SuggestionApplyError } from "../suggestions/apply.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;

async function pendingUpdate(fixture: Fixture, taskId: string, receivedAt: string, diff: Record<string, unknown>) {
  const [source] = await db
    .insert(sources)
    .values({ organizationId: fixture.org.id, type: "gmail", externalId: randomUUID(), receivedAt: new Date(receivedAt), rawBody: "x" })
    .returning();
  const [row] = await db
    .insert(suggestions)
    .values({
      organizationId: fixture.org.id,
      sourceId: source.id,
      targetType: "task",
      targetId: taskId,
      changeType: "operational_update",
      proposedDiff: diff,
      reasoning: "r",
      confidence: 0.9,
    })
    .returning();
  return row;
}

describe("chronology at approval time", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("an August note approved after September evidence can't replace the newer state", async () => {
    const fixture = await createFixtureOrg(db, { domain: "chrono-block.test" });
    const [task] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Explant tissue IHC" }).returning();
    // Both were proposed before either was approved, so neither was held back at ingestion.
    const august = await pendingUpdate(fixture, task.id, "2026-08-10T12:00:00Z", { latestUpdate: "Tissue folding; re-cut needed.", nextAction: "Re-cut blocks" });
    const september = await pendingUpdate(fixture, task.id, "2026-09-16T12:00:00Z", { latestUpdate: "Slides scanned; interpretation under way.", nextAction: "Review scans" });

    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: september.id, reviewerId: fixture.user.id });
    const attempt = approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: august.id, reviewerId: fixture.user.id });
    await expect(attempt).rejects.toBeInstanceOf(SuggestionApplyError);
    await expect(attempt).rejects.toThrow("newer information for latestUpdate, nextAction (from 2026-09-16); this update is from 2026-08-10");

    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after).toMatchObject({ latestUpdate: "Slides scanned; interpretation under way.", nextAction: "Review scans" });
    expect((after.fieldEvidence as Record<string, { asOf: string }>).latestUpdate.asOf.slice(0, 10)).toBe("2026-09-16");
  });

  it("applies what's still new, holds back what's stale, and records the held-back fields", async () => {
    const fixture = await createFixtureOrg(db, { domain: "chrono-partial.test" });
    const [task] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Diffusion study" }).returning();
    const older = await pendingUpdate(fixture, task.id, "2026-08-01T12:00:00Z", { description: "Patient Gd/BBB concept.", owner: "Nassir" });
    const newer = await pendingUpdate(fixture, task.id, "2026-09-20T12:00:00Z", { description: "Preclinical diffusion study in rodents." });

    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: newer.id, reviewerId: fixture.user.id });
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: older.id, reviewerId: fixture.user.id });

    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after).toMatchObject({ description: "Preclinical diffusion study in rodents.", owner: "Nassir" });
    const [row] = await db.select().from(suggestions).where(eq(suggestions.id, older.id));
    expect(row.status).toBe("approved");
    expect(row.conflicts).toMatchObject([{ field: "description", proposedValue: "Patient Gd/BBB concept.", currentValue: "Preclinical diffusion study in rodents." }]);
  });

  it("in-order approvals are unaffected", async () => {
    const fixture = await createFixtureOrg(db, { domain: "chrono-order.test" });
    const [task] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "T" }).returning();
    const first = await pendingUpdate(fixture, task.id, "2026-08-01T12:00:00Z", { latestUpdate: "old" });
    const second = await pendingUpdate(fixture, task.id, "2026-09-01T12:00:00Z", { latestUpdate: "new" });
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: first.id, reviewerId: fixture.user.id });
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: second.id, reviewerId: fixture.user.id });
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after.latestUpdate).toBe("new");
  });
});
