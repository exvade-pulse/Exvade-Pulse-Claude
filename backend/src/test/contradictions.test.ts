import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { approveSuggestion, editSuggestion } from "../suggestions/apply.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { findContradictions, type CheckedRecord } from "../interpretation/contradictionDetection.js";
import { buildExecutiveReviewData, renderExecutiveReviewText } from "../reports/executiveReview.js";
import { diffReviews, summarizeReview } from "../reports/reviewChanges.js";
import { syncDeadlineItems } from "../reports/deadlineItems.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;
const DAY = 24 * 60 * 60 * 1000;

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

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

const TASK_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const DECISION_ID = "bbbbbbbb-2222-4222-8222-222222222222";

const needleTask: CheckedRecord = {
  type: "task",
  id: TASK_ID,
  title: "White pellet characterization",
  statements: [{ field: "description", value: "Pellet collected using 18G.", asOf: null }],
  history: [{ date: "2026-09-20T00:00:00Z", text: "latestUpdate: Collection may actually have used 21G." }],
};

const finding = {
  recordType: "task",
  recordId: TASK_ID,
  field: "description",
  olderStatement: "Pellet collected using 18G.",
  olderDate: null,
  newerStatement: "Collection may actually have used 21G.",
  newerDate: "2026-09-20",
  correctedValue: "Needle gauge unconfirmed: earlier notes said 18G, newer evidence suggests 21G.",
  reasoning: "The gauge attribution was later questioned.",
  confidence: 0.9,
};

describe("findContradictions", () => {
  it("returns genuine findings and drops anything outside the batch, uncorrectable, or repeated", async () => {
    const fake: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_contradictions", {
          contradictions: [
            finding,
            { ...finding, reasoning: "Same record and field again." },
            { ...finding, recordId: "99999999-9999-4999-8999-999999999999" },
            { ...finding, recordType: "decision" },
            { ...finding, field: "visibility" },
            { ...finding, field: "status", correctedValue: "maybe" },
          ],
        }),
    };
    const result = await findContradictions([needleTask], "under a project", fake);
    expect(result).toEqual([{ ...finding, recordType: "task" }]);
  });

  it("makes no call for an empty batch and returns nothing when the model finds nothing", async () => {
    const neverCalled: ClaudeClient = {
      createMessage: async () => {
        throw new Error("should not be called");
      },
    };
    expect(await findContradictions([], "x", neverCalled)).toEqual([]);
    const empty: ClaudeClient = { createMessage: async () => toolUseMessage("flag_contradictions", { contradictions: [] }) };
    expect(await findContradictions([needleTask], "x", empty)).toEqual([]);
  });
});

describe("POST /api/reviews/check-contradictions", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function runCheck(fixture: Fixture, respond: (recordId: string) => unknown[]) {
    const fake: ClaudeClient = {
      createMessage: async (params) => {
        const prompt = String(params.messages[0].content);
        const ids = [...prompt.matchAll(/id=([0-9a-f-]{36})/g)].map((m) => m[1]);
        return toolUseMessage("flag_contradictions", { contradictions: ids.flatMap(respond) });
      },
    };
    const app = await buildApp();
    setClaudeClientForTesting(fake);
    const response = await app.inject({ method: "POST", url: "/api/reviews/check-contradictions", cookies: await cookieFor(fixture) });
    setClaudeClientForTesting(undefined);
    await app.close();
    return response;
  }

  it("turns a conflict into a correction waiting in Review, then applies it only on approval", async () => {
    const fixture = await createFixtureOrg(db, { domain: "contra-flow.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "White pellet", description: "Pellet collected using 18G." })
      .returning();

    const response = await runCheck(fixture, (id) => (id === task.id ? [{ ...finding, recordId: task.id }] : []));
    expect(response.json()).toEqual({ recordsChecked: 1, contradictionsFound: 1 });

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.targetId, task.id));
    expect(suggestion).toMatchObject({ changeType: "contradiction", status: "pending", proposedDiff: { description: finding.correctedValue } });
    expect(suggestion.conflicts).toEqual([
      {
        kind: "contradiction",
        field: "description",
        olderStatement: finding.olderStatement,
        olderDate: null,
        newerStatement: finding.newerStatement,
        newerDate: "2026-09-20",
      },
    ]);
    const [untouched] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(untouched.description).toBe("Pellet collected using 18G.");

    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: suggestion.id, reviewerId: fixture.user.id });
    const [corrected] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(corrected.description).toBe(finding.correctedValue);
  });

  it("doesn't re-flag a record and field already waiting on a conflict, and an ordinary update never folds into it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "contra-repeat.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "White pellet", description: "18G" })
      .returning();
    const respond = (id: string) => (id === task.id ? [{ ...finding, recordId: task.id }] : []);

    await runCheck(fixture, respond);
    const second = await runCheck(fixture, respond);
    expect(second.json().contradictionsFound).toBe(0);

    await mergeOrInsertSuggestion(db, {
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      sourceReceivedAt: new Date(),
      draft: { changeType: "operational_update", targetType: "task", targetId: task.id, proposedDiff: { nextAction: "Re-test" }, reasoning: "x", confidence: 0.7 },
    });
    const rows = await db.select().from(suggestions).where(eq(suggestions.targetId, task.id));
    expect(rows.map((r) => r.changeType).sort()).toEqual(["contradiction", "operational_update"]);
  });

  it("shows conflicts prominently in the executive review and as new since the last review", async () => {
    const fixture = await createFixtureOrg(db, { domain: "contra-exec.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "White pellet", description: "18G" })
      .returning();
    const before = summarizeReview(await buildExecutiveReviewData(fixture.org.id, "admin"));

    await runCheck(fixture, (id) => (id === task.id ? [{ ...finding, recordId: task.id }] : []));
    const data = await buildExecutiveReviewData(fixture.org.id, "admin");

    expect(data.contradictions).toMatchObject([
      { recordTitle: "White pellet", field: "description", olderStatement: finding.olderStatement, correctedValue: finding.correctedValue },
    ]);
    expect(data.headline.some((h) => h.startsWith("1 conflict: newer information contradicts"))).toBe(true);
    const text = renderExecutiveReviewText(data);
    expect(text.indexOf("CONFLICTS DETECTED")).toBeLessThan(text.indexOf("1. DECISIONS NEEDED"));
    expect(text).toContain("Proposed correction, awaiting approval:");
    expect(diffReviews(before, summarizeReview(data)).map((c) => c.kind)).toContain("NEW_CONTRADICTION");
  });
});

describe("deadline passed items", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  async function overdueDecision(fixture: Fixture, title: string) {
    const [row] = await db
      .insert(decisions)
      .values({ organizationId: fixture.org.id, title, decider: "CEO", dueDate: new Date(Date.now() - 3 * DAY) })
      .returning();
    return row;
  }

  async function pendingItems(fixture: Fixture) {
    return db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, fixture.org.id), eq(suggestions.changeType, "deadline_passed"), eq(suggestions.status, "pending")));
  }

  it("asks once per undecided overdue decision, without piling up on repeat", async () => {
    const fixture = await createFixtureOrg(db, { domain: "deadline-once.test" });
    const late = await overdueDecision(fixture, "Trademark strategy");
    await db.insert(decisions).values([
      { organizationId: fixture.org.id, title: "Future call", decider: "CEO", dueDate: new Date(Date.now() + 5 * DAY) },
      { organizationId: fixture.org.id, title: "Already decided", decider: "CEO", status: "decided", dueDate: new Date(Date.now() - 5 * DAY) },
    ]);

    expect(await syncDeadlineItems(db, fixture.org.id)).toEqual({ created: 1, resolved: 0 });
    expect(await syncDeadlineItems(db, fixture.org.id)).toEqual({ created: 0, resolved: 0 });
    const items = await pendingItems(fixture);
    expect(items).toHaveLength(1);
    expect(items[0].targetId).toBe(late.id);
    expect(items[0].reasoning).toContain("What actually happened?");
  });

  it("clears itself once the decision is decided elsewhere", async () => {
    const fixture = await createFixtureOrg(db, { domain: "deadline-clears.test" });
    const late = await overdueDecision(fixture, "Trademark strategy");
    await syncDeadlineItems(db, fixture.org.id);

    await db.update(decisions).set({ status: "decided", resolution: "Keep US marks only" }).where(eq(decisions.id, late.id));
    expect(await syncDeadlineItems(db, fixture.org.id)).toEqual({ created: 0, resolved: 1 });
    expect(await pendingItems(fixture)).toHaveLength(0);
  });

  it("editing in a new due date and approving moves the deadline, and the question goes away", async () => {
    const fixture = await createFixtureOrg(db, { domain: "deadline-extend.test" });
    const late = await overdueDecision(fixture, "Trademark strategy");
    await syncDeadlineItems(db, fixture.org.id);
    const [item] = await pendingItems(fixture);

    const newDue = new Date(Date.now() + 30 * DAY).toISOString();
    await editSuggestion(db, { organizationId: fixture.org.id, suggestionId: item.id, actorId: fixture.user.id, diff: { dueDate: newDue } });
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: item.id, reviewerId: fixture.user.id });

    const [row] = await db.select().from(decisions).where(eq(decisions.id, late.id));
    expect(row.dueDate?.toISOString()).toBe(newDue);
    expect(await syncDeadlineItems(db, fixture.org.id)).toEqual({ created: 0, resolved: 0 });
  });

  it("appears in the review queue without anyone running a check", async () => {
    const fixture = await createFixtureOrg(db, { domain: "deadline-queue.test" });
    await overdueDecision(fixture, "Trademark strategy");
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/suggestions", cookies: await cookieFor(fixture) });
    await app.close();
    const rows = response.json().suggestions as Array<{ changeType: string }>;
    expect(rows.map((r) => r.changeType)).toEqual(["deadline_passed"]);
  });
});
