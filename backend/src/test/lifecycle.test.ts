import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, decisions, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { approveSuggestion, SuggestionApplyError } from "../suggestions/apply.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { titleSimilarity, titleTokens, LIKELY_DUPLICATE_THRESHOLD } from "../suggestions/similarity.js";
import { buildExecutiveReviewData } from "../reports/executiveReview.js";
import { diffReviews, type ReviewSnapshotSummary } from "../reports/reviewChanges.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;
const DAY = 24 * 60 * 60 * 1000;

async function cookieFor(fixture: Fixture) {
  return {
    [SESSION_COOKIE_NAME]: await signSession({
      userId: fixture.user.id,
      organizationId: fixture.org.id,
      email: fixture.user.email,
      role: fixture.authorization.role,
    }),
  };
}

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

async function decision(fixture: Fixture, values: Partial<typeof decisions.$inferInsert> & { title: string }) {
  const [row] = await db
    .insert(decisions)
    .values({ organizationId: fixture.org.id, decider: "CEO", ...values })
    .returning();
  return row;
}

async function task(fixture: Fixture, values: Partial<typeof tasks.$inferInsert> & { title: string }) {
  const [row] = await db
    .insert(tasks)
    .values({ organizationId: fixture.org.id, projectId: fixture.project.id, status: "active", ...values })
    .returning();
  return row;
}

describe("decision lifecycle", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function setStatus(fixture: Fixture, id: string, status: string, note?: string) {
    const app = await buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${id}/status`,
      payload: { status, note },
      cookies: await cookieFor(fixture),
    });
    await app.close();
    return response;
  }

  it("moves open <-> pending info, and decided -> in progress -> closed", async () => {
    const fixture = await createFixtureOrg(db, { domain: "life-moves.test" });
    const open = await decision(fixture, { title: "Pick a vendor" });
    const decided = await decision(fixture, { title: "Hire a CFO", status: "decided", resolution: "Yes" });

    expect((await setStatus(fixture, open.id, "pending_info")).json().decision.status).toBe("pending_info");
    expect((await setStatus(fixture, open.id, "open")).json().decision.status).toBe("open");
    expect((await setStatus(fixture, decided.id, "action_in_progress")).json().decision.status).toBe("action_in_progress");
    const closed = await setStatus(fixture, decided.id, "closed", "Engagement signed");
    expect(closed.json().decision.status).toBe("closed");
    expect(closed.json().decision.resolution).toContain("Yes");
    expect(closed.json().decision.resolution).toContain("Engagement signed");

    const logged = await db.select().from(auditLog).where(eq(auditLog.action, "decision.status_changed"));
    expect(logged).toHaveLength(4);
  });

  it("refuses to close a never-made decision without a note, and refuses nonsense moves", async () => {
    const fixture = await createFixtureOrg(db, { domain: "life-refuse.test" });
    const open = await decision(fixture, { title: "Pick a vendor" });

    const noNote = await setStatus(fixture, open.id, "closed");
    expect(noNote.statusCode).toBe(409);
    expect(noNote.json().error).toContain("what happened");

    expect((await setStatus(fixture, open.id, "action_in_progress")).statusCode).toBe(409);
    expect((await setStatus(fixture, open.id, "superseded")).statusCode).toBe(400);

    const withNote = await setStatus(fixture, open.id, "closed", "Vendor withdrew; moot");
    expect(withNote.json().decision.status).toBe("closed");
  });

  it("lists live decisions by default, and accepts 'undecided' or a single status", async () => {
    const fixture = await createFixtureOrg(db, { domain: "life-list.test" });
    await decision(fixture, { title: "Open one" });
    await decision(fixture, { title: "Waiting one", status: "pending_info" });
    await decision(fixture, { title: "Doing one", status: "action_in_progress" });
    await decision(fixture, { title: "Decided one", status: "decided" });
    await decision(fixture, { title: "Closed one", status: "closed" });

    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    const titles = async (query: string) =>
      ((await app.inject({ method: "GET", url: `/api/decisions${query}`, cookies })).json() as { decisions: Array<{ title: string }> }).decisions
        .map((d) => d.title)
        .sort();
    const live = await titles("");
    const undecided = await titles("?status=undecided");
    const decidedOnly = await titles("?status=decided");
    const bogus = await app.inject({ method: "GET", url: "/api/decisions?status=bogus", cookies });
    await app.close();

    expect(live).toEqual(["Doing one", "Open one", "Waiting one"]);
    expect(undecided).toEqual(["Open one", "Waiting one"]);
    expect(decidedOnly).toEqual(["Decided one"]);
    expect(bogus.statusCode).toBe(400);
  });

  it("a decision already being carried out no longer blocks its task; one waiting on info still does", async () => {
    const fixture = await createFixtureOrg(db, { domain: "life-blocking.test" });
    const a = await task(fixture, { title: "Ship harness", status: "blocked" });
    const b = await task(fixture, { title: "Order parts", status: "blocked" });
    await decision(fixture, { title: "Vendor choice", status: "action_in_progress", relatedTaskId: a.id });
    await decision(fixture, { title: "Budget sign-off", status: "pending_info", relatedTaskId: b.id });

    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    const blockerOf = async (id: string) =>
      ((await app.inject({ method: "GET", url: `/api/tasks/${id}`, cookies })).json() as { blockingDecision: { title: string } | null })
        .blockingDecision;
    const forA = await blockerOf(a.id);
    const forB = await blockerOf(b.id);
    await app.close();

    expect(forA).toBeNull();
    expect(forB?.title).toBe("Budget sign-off");
  });

  it("the executive review keeps pending-info decisions under 'needed' and in-progress ones out of 'deadline passed'", async () => {
    const fixture = await createFixtureOrg(db, { domain: "life-exec.test" });
    const now = new Date();
    await decision(fixture, { title: "Waiting call", status: "pending_info" });
    await decision(fixture, { title: "Late but underway", status: "action_in_progress", dueDate: new Date(now.getTime() - 5 * DAY) });

    const data = await buildExecutiveReviewData(fixture.org.id, "admin", now);
    expect(data.decisionsNeeded.map((d) => [d.title, d.status])).toEqual([["Waiting call", "pending_info"]]);
    expect(data.deadlinePassed).toEqual([]);
    expect(data.decisionsInProgress.map((d) => d.title)).toEqual(["Late but underway"]);
  });
});

describe("merging duplicates", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function mergeSuggestion(fixture: Fixture, targetType: "task" | "decision", duplicateId: string, keepId: string) {
    const [row] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType,
        targetId: duplicateId,
        changeType: "merge",
        proposedDiff: { supersededById: keepId },
        reasoning: "Same question worded differently.",
        confidence: 0.92,
      })
      .returning();
    return row;
  }

  it("approving a decision merge keeps both rows, links the duplicate, and carries its notes over", async () => {
    const fixture = await createFixtureOrg(db, { domain: "merge-decision.test" });
    const keep = await decision(fixture, { title: "Which path for Fast Track Aim 1?", stakeholders: ["CFO"] });
    const dup = await decision(fixture, {
      title: "What path for Fast Track Aim 1?",
      whyItMatters: "Outside option costs ~$213K.",
      stakeholders: ["Board"],
      dueDate: new Date("2026-10-15T00:00:00Z"),
    });
    const suggestion = await mergeSuggestion(fixture, "decision", dup.id, keep.id);

    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id });

    const [keptRow] = await db.select().from(decisions).where(eq(decisions.id, keep.id));
    const [dupRow] = await db.select().from(decisions).where(eq(decisions.id, dup.id));
    expect(dupRow.status).toBe("superseded");
    expect(dupRow.supersededById).toBe(keep.id);
    expect(dupRow.whyItMatters).toBe("Outside option costs ~$213K."); // its own history is untouched
    expect(keptRow.status).toBe("open");
    expect(keptRow.relevantContext).toContain('merged from duplicate "What path for Fast Track Aim 1?"');
    expect(keptRow.relevantContext).toContain("Outside option costs ~$213K.");
    expect(keptRow.stakeholders.sort()).toEqual(["Board", "CFO"]);
    expect(keptRow.dueDate?.toISOString()).toBe("2026-10-15T00:00:00.000Z");

    const actions = (await db.select().from(auditLog).where(eq(auditLog.organizationId, fixture.org.id))).map((a) => a.action).sort();
    expect(actions).toEqual(["decision.merged_into", "decision.superseded"]);
  });

  it("approving a task merge supersedes the duplicate and fills gaps on the kept task", async () => {
    const fixture = await createFixtureOrg(db, { domain: "merge-task.test" });
    const keep = await task(fixture, { title: "Bench rig #3 sensor dropout" });
    const dup = await task(fixture, { title: "Follow up: rig #3 dropout", owner: "Karen", nextAction: "Escalate to firmware lead", latestUpdate: "Recurred 3x today" });
    const suggestion = await mergeSuggestion(fixture, "task", dup.id, keep.id);

    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id });

    const [keptRow] = await db.select().from(tasks).where(eq(tasks.id, keep.id));
    const [dupRow] = await db.select().from(tasks).where(eq(tasks.id, dup.id));
    expect(dupRow).toMatchObject({ status: "superseded", supersededById: keep.id, latestUpdate: "Recurred 3x today" });
    expect(keptRow).toMatchObject({ status: "active", owner: "Karen", nextAction: "Escalate to firmware lead" });
    expect(keptRow.description).toContain("Recurred 3x today");
  });

  it("fails one merge gracefully when the record to keep has itself been superseded", async () => {
    const fixture = await createFixtureOrg(db, { domain: "merge-stale.test" });
    const a = await task(fixture, { title: "A" });
    const b = await task(fixture, { title: "B", status: "superseded" });
    const suggestion = await mergeSuggestion(fixture, "task", a.id, b.id);

    await expect(
      approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);
    const [aRow] = await db.select().from(tasks).where(eq(tasks.id, a.id));
    expect(aRow.status).toBe("active");
  });

  it("a merge proposal never folds into an ordinary pending update on the same task", async () => {
    const fixture = await createFixtureOrg(db, { domain: "merge-separate.test" });
    const keep = await task(fixture, { title: "Keep" });
    const dup = await task(fixture, { title: "Dup" });
    const base = { organizationId: fixture.org.id, sourceId: fixture.source.id, sourceReceivedAt: new Date() };
    await mergeOrInsertSuggestion(db, {
      ...base,
      draft: { changeType: "operational_update", targetType: "task", targetId: dup.id, proposedDiff: { status: "blocked" }, reasoning: "x", confidence: 0.6 },
    });
    await mergeOrInsertSuggestion(db, {
      ...base,
      draft: { changeType: "merge", targetType: "task", targetId: dup.id, proposedDiff: { supersededById: keep.id }, reasoning: "y", confidence: 0.9 },
    });
    await mergeOrInsertSuggestion(db, {
      ...base,
      draft: { changeType: "operational_update", targetType: "task", targetId: dup.id, proposedDiff: { nextAction: "Call" }, reasoning: "z", confidence: 0.7 },
    });

    const rows = await db.select().from(suggestions).where(eq(suggestions.targetId, dup.id));
    expect(rows.map((r) => r.changeType).sort()).toEqual(["merge", "operational_update"]);
    const update = rows.find((r) => r.changeType === "operational_update")!;
    expect(update.proposedDiff).toEqual({ status: "blocked", nextAction: "Call" });
  });

  it("the duplicate check proposes decision merges, and doesn't re-propose one already waiting", async () => {
    const fixture = await createFixtureOrg(db, { domain: "merge-check.test" });
    const keep = await decision(fixture, { title: "Which path for Aim 1?" });
    const dup = await decision(fixture, { title: "What path for Aim 1?" });
    const fake: ClaudeClient = {
      createMessage: async (params) =>
        (params.tools?.[0] as { name?: string } | undefined)?.name === "flag_duplicate_decisions"
          ? toolUseMessage("flag_duplicate_decisions", {
              duplicates: [{ keepDecisionId: keep.id, supersedeDecisionId: dup.id, reasoning: "Same question.", confidence: 0.93 }],
            })
          : toolUseMessage("flag_duplicate_tasks", { duplicates: [] }),
    };

    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    setClaudeClientForTesting(fake);
    const first = await app.inject({ method: "POST", url: "/api/tasks/check-duplicates", cookies });
    const second = await app.inject({ method: "POST", url: "/api/tasks/check-duplicates", cookies });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(first.json()).toMatchObject({ decisionsChecked: 2, decisionDuplicatesFound: 1 });
    expect(second.json()).toMatchObject({ decisionsChecked: 2, decisionDuplicatesFound: 0 });
    const merges = await db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, fixture.org.id), eq(suggestions.changeType, "merge")));
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ targetType: "decision", targetId: dup.id, proposedDiff: { supersededById: keep.id } });
  });
});

describe("duplicate hints in the review queue", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("scores the real reworded decision titles as duplicates and merely-related tasks as not", () => {
    const a = titleTokens(
      "Which path should be chosen for Fast Track Grant Aim 1 (longitudinal rodent sampling) and what is the restart schedule for Aim 2 (large animal explant study)?",
    );
    const b = titleTokens("What path should be chosen for Fast Track Grant Aim 1, and what schedule should be restarted for Aim 2?");
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(LIKELY_DUPLICATE_THRESHOLD);

    const related = titleSimilarity(
      titleTokens("Recalibrate sensor rig #3"),
      titleTokens("Verify sensor calibration procedure against bench rig #3 findings"),
    );
    expect(related).toBeLessThan(LIKELY_DUPLICATE_THRESHOLD);
  });

  it("flags a pending new decision that copies an existing one or an earlier pending one, and names a merge's target", async () => {
    const fixture = await createFixtureOrg(db, { domain: "hints.test" });
    const existing = await decision(fixture, { title: "Which trademarks are worth continuing to pursue?" });
    const keep = await task(fixture, { title: "Keep task" });
    const dup = await task(fixture, { title: "Dup task" });
    const base = { organizationId: fixture.org.id, sourceId: fixture.source.id, targetType: "decision" as const, targetId: null, changeType: "decision" as const, reasoning: "x", confidence: 0.7 };
    await db.insert(suggestions).values([
      { ...base, proposedDiff: { title: "Which trademarks are worth continuing to pursue and defend?", decider: "CEO" }, createdAt: new Date(Date.now() - 3000) },
      { ...base, proposedDiff: { title: "Should we switch sensor vendors?", decider: "CEO" }, createdAt: new Date(Date.now() - 2000) },
      { ...base, proposedDiff: { title: "Should we switch our sensor vendor?", decider: "CEO" }, createdAt: new Date(Date.now() - 1000) },
      {
        organizationId: fixture.org.id, sourceId: fixture.source.id, targetType: "task", targetId: dup.id, changeType: "merge",
        proposedDiff: { supersededById: keep.id }, reasoning: "same", confidence: 0.9,
      },
    ]);

    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/suggestions", cookies: await cookieFor(fixture) });
    await app.close();

    const rows = response.json().suggestions as Array<{
      changeType: string;
      proposedDiff: { title?: string };
      likelyDuplicateOf: { kind: string; title: string } | null;
      mergeInto: { title: string } | null;
    }>;
    const byTitle = (t: string) => rows.find((r) => r.proposedDiff.title === t)!;
    expect(byTitle("Which trademarks are worth continuing to pursue and defend?").likelyDuplicateOf).toMatchObject({
      kind: "existing",
      title: existing.title,
    });
    expect(byTitle("Should we switch sensor vendors?").likelyDuplicateOf).toBeNull();
    expect(byTitle("Should we switch our sensor vendor?").likelyDuplicateOf).toMatchObject({
      kind: "pending",
      title: "Should we switch sensor vendors?",
    });
    expect(rows.find((r) => r.changeType === "merge")!.mergeInto).toMatchObject({ title: "Keep task" });
  });
});

describe("since last review", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  const empty: ReviewSnapshotSummary = { decisions: [], tasks: [] };

  it("ranks what changed: overdue first, then new decisions and risks, down to things going stale", () => {
    const previous: ReviewSnapshotSummary = {
      decisions: [
        { id: "d1", title: "Vendor call", bucket: "needed" },
        { id: "d2", title: "CFO scope", bucket: "needed" },
      ],
      tasks: [
        { id: "t1", title: "Order parts", status: "active", section: "operating", score: 30 },
        { id: "t2", title: "Old task", status: "active", section: "operating", score: 20 },
        { id: "t3", title: "Rig fix", status: "blocked", section: "risk", score: 60 },
      ],
    };
    const current: ReviewSnapshotSummary = {
      decisions: [
        { id: "d1", title: "Vendor call", bucket: "passed" },
        { id: "d3", title: "Needle size", bucket: "needed" },
      ],
      tasks: [
        { id: "t1", title: "Order parts", status: "blocked", section: "risk", score: 70 },
        { id: "t2", title: "Old task", status: "active", section: "disposition", score: 10 },
      ],
    };

    expect(diffReviews(previous, current).map((c) => [c.kind, c.title])).toEqual([
      ["BECAME_OVERDUE", "Vendor call"],
      ["NEW_DECISION", "Needle size"],
      ["NEW_RISK", "Order parts"],
      ["DECISION_RESOLVED", "CFO scope"],
      ["RISK_CLEARED", "Rig fix"],
      ["NOW_STALE", "Old task"],
    ]);
    expect(diffReviews(current, current)).toEqual([]);
    expect(diffReviews(empty, empty)).toEqual([]);
  });

  it("is empty until marked reviewed, then reports what changed after that", async () => {
    const fixture = await createFixtureOrg(db, { domain: "since.test" });
    await task(fixture, { title: "Steady task", nextAction: "Keep going" });

    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    const review = async () =>
      (await app.inject({ method: "GET", url: "/api/reports/executive-review", cookies })).json() as {
        text: string;
        data: { sinceLastReview: { changes: Array<{ kind: string; title: string }> } | null };
      };

    expect((await review()).data.sinceLastReview).toBeNull();
    const marked = await app.inject({ method: "POST", url: "/api/reports/executive-review/mark-reviewed", cookies });
    expect(marked.statusCode).toBe(201);
    expect((await review()).data.sinceLastReview?.changes).toEqual([]);

    await task(fixture, { title: "Newly blocked", status: "blocked" });
    await decision(fixture, { title: "New call needed" });
    const after = await review();
    await app.close();

    expect(after.data.sinceLastReview?.changes.map((c) => [c.kind, c.title])).toEqual([
      ["NEW_DECISION", "New call needed"],
      ["NEW_RISK", "Newly blocked"],
    ]);
    expect(after.text).toContain("SINCE MY LAST REVIEW");
    expect(after.text).toContain("- New call needed: New decision needed");
  });
});

describe("closing out a task directly", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function setTaskStatus(fixture: Fixture, id: string, status: string, note?: string) {
    const app = await buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}/status`,
      payload: { status, note },
      cookies: await cookieFor(fixture),
    });
    await app.close();
    return response;
  }

  it("marks a task not relevant anymore without deleting it, and it drops out of the review", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dispose-cancel.test" });
    const old = await task(fixture, { title: "Review lab fund balances", updatedAt: new Date(Date.now() - 400 * DAY) });

    const before = await buildExecutiveReviewData(fixture.org.id, "admin");
    expect(before.needsDisposition.map((t) => t.title)).toEqual(["Review lab fund balances"]);

    const response = await setTaskStatus(fixture, old.id, "cancelled", "Old lab funding question, no longer applies");
    expect(response.statusCode).toBe(200);
    expect(response.json().task).toMatchObject({
      status: "cancelled",
      latestUpdate: "Marked not relevant anymore: Old lab funding question, no longer applies",
    });

    const [row] = await db.select().from(tasks).where(eq(tasks.id, old.id));
    expect(row.title).toBe("Review lab fund balances"); // still there
    expect((row.fieldEvidence as Record<string, { asOf: string }>).status.asOf).toBeTruthy();
    const after = await buildExecutiveReviewData(fixture.org.id, "admin");
    expect(after.needsDisposition).toEqual([]);
    expect(after.counts.openTasks).toBe(0);

    const [logged] = await db.select().from(auditLog).where(eq(auditLog.action, "task.status_set_manually"));
    expect(logged.details).toMatchObject({ from: "active", to: "cancelled" });
  });

  it("an older source can't quietly reopen a task a person cancelled -- it's held back as a conflict", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dispose-conflict.test" });
    const t = await task(fixture, { title: "Review lab fund balances" });
    await setTaskStatus(fixture, t.id, "cancelled");

    await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      sourceReceivedAt: new Date(Date.now() - 30 * DAY),
      draft: { changeType: "operational_update", targetType: "task", targetId: t.id, proposedDiff: { status: "active" }, reasoning: "old note", confidence: 0.6 },
    });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.targetId, t.id));
    expect(suggestion.proposedDiff).toEqual({});
    expect(suggestion.conflicts).toMatchObject([{ field: "status", proposedValue: "active", currentValue: "cancelled" }]);
  });

  it("reopens a done or cancelled task, but not a merged one; refuses to close one twice", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dispose-reopen.test" });
    const done = await task(fixture, { title: "Done one", status: "completed" });
    const merged = await task(fixture, { title: "Merged one", status: "superseded" });
    const open = await task(fixture, { title: "Open one" });

    expect((await setTaskStatus(fixture, done.id, "active")).json().task.status).toBe("active");
    expect((await setTaskStatus(fixture, merged.id, "active")).statusCode).toBe(409);
    expect((await setTaskStatus(fixture, open.id, "completed")).json().task.status).toBe("completed");
    expect((await setTaskStatus(fixture, open.id, "cancelled")).statusCode).toBe(409);
    expect((await setTaskStatus(fixture, open.id, "blocked")).statusCode).toBe(400);
  });

  it("a member can't close out a restricted task they can't see", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dispose-member.test", role: "member" });
    const secret = await task(fixture, { title: "Term sheet", visibility: "restricted" });
    expect((await setTaskStatus(fixture, secret.id, "cancelled")).statusCode).toBe(404);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, secret.id));
    expect(row.status).toBe("active");
  });
});
