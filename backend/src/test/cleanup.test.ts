import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { approveSuggestion, SuggestionApplyError } from "../suggestions/apply.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { proposeCleanup, type CleanupCandidate, type CleanupContext } from "../interpretation/cleanupDetection.js";
import { buildExecutiveReviewData } from "../reports/executiveReview.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function toolUseMessage(input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name: "propose_cleanup", input }] } as unknown as Anthropic.Message;
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

const STALE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_ID = "cccccccc-3333-4333-8333-333333333333";
const DECISION_ID = "bbbbbbbb-2222-4222-8222-222222222222";

const staleTask: CleanupCandidate = {
  type: "task",
  id: STALE_ID,
  title: "Grant check-in",
  status: "active",
  why: "stale",
  nextAction: "Email program officer",
  latestUpdate: null,
  lastEvidence: "2026-05-01T00:00:00Z",
};
const staleDecision: CleanupCandidate = { ...staleTask, type: "decision", id: DECISION_ID, title: "Outsource testing?", why: "stale_next_action" };
const context: CleanupContext = {
  scope: "in a workstream",
  otherTasks: [{ id: OTHER_ID, title: "Grant reporting", status: "active", nextAction: null, lastEvidence: "2026-09-20T00:00:00Z" }],
  recentUpdates: [],
  openDecisions: [],
};
const base = { reasoning: "Evidence says so.", confidence: 0.8 };

describe("proposeCleanup", () => {
  it("keeps one well-formed proposal per flagged record and drops everything else", async () => {
    const fake: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage({
          proposals: [
            { ...base, recordType: "task", recordId: STALE_ID, action: "supersede", supersededById: OTHER_ID },
            { ...base, recordType: "task", recordId: STALE_ID, action: "close_completed" },
            { ...base, recordType: "task", recordId: OTHER_ID, action: "close_completed" },
            { ...base, recordType: "decision", recordId: DECISION_ID, action: "close_abandoned" },
            { ...base, recordType: "decision", recordId: DECISION_ID, action: "update_next_action", newNextAction: "Get two quotes" },
          ],
        }),
    };
    const result = await proposeCleanup([staleTask, staleDecision], context, fake);
    expect(result.map((p) => [p.recordId, p.action])).toEqual([
      [STALE_ID, "supersede"],
      [DECISION_ID, "update_next_action"],
    ]);
    expect(result[0].supersededById).toBe(OTHER_ID);
    expect(result[1].newNextAction).toBe("Get two quotes");
  });

  it("rejects a supersede pointing outside the workstream, a replace without a title, and a next-action update without one", async () => {
    const fake: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage({
          proposals: [
            { ...base, recordType: "task", recordId: STALE_ID, action: "supersede", supersededById: "99999999-9999-4999-8999-999999999999" },
            { ...base, recordType: "task", recordId: STALE_ID, action: "replace", replacement: null },
            { ...base, recordType: "decision", recordId: DECISION_ID, action: "update_next_action", newNextAction: null },
          ],
        }),
    };
    expect(await proposeCleanup([staleTask, staleDecision], context, fake)).toEqual([]);
  });

  it("makes no call for an empty batch", async () => {
    const neverCalled: ClaudeClient = {
      createMessage: async () => {
        throw new Error("should not be called");
      },
    };
    expect(await proposeCleanup([], context, neverCalled)).toEqual([]);
  });
});

describe("POST /api/reviews/cleanup", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  // Answers for every flagged record the prompt names ("task id=..." /
  // "decision id=..."); other workstream tasks are listed as "- id=...".
  async function runCleanup(fixture: Fixture, respond: (type: string, id: string) => unknown[]) {
    const fake: ClaudeClient = {
      createMessage: async (params) => {
        const prompt = String(params.messages[0].content);
        const flagged = [...prompt.matchAll(/^(task|decision) id=([0-9a-f-]{36})/gm)];
        return toolUseMessage({ proposals: flagged.flatMap((m) => respond(m[1], m[2])) });
      },
    };
    const app = await buildApp();
    setClaudeClientForTesting(fake);
    const response = await app.inject({ method: "POST", url: "/api/reviews/cleanup", cookies: await cookieFor(fixture) });
    setClaudeClientForTesting(undefined);
    await app.close();
    return response;
  }

  async function seed(fixture: Fixture) {
    const [old] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Grant check-in", nextAction: "Email program officer", updatedAt: daysAgo(120) })
      .returning();
    const [drifting] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Follow-on study scoping",
        nextAction: "Wait for Sandra's proposal due May 8",
        updatedAt: daysAgo(2),
        fieldEvidence: { nextAction: { asOf: daysAgo(40).toISOString(), sourceId: null } },
      })
      .returning();
    const [fresh] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Grant reporting", updatedAt: daysAgo(1) })
      .returning();
    const [decision] = await db
      .insert(decisions)
      .values({ organizationId: fixture.org.id, title: "Outsource testing?", decider: "CEO", suggestedNextStep: "Wait for quote", updatedAt: daysAgo(60) })
      .returning();
    return { old, drifting, fresh, decision };
  }

  it("proposes one resolution per flagged record, changes nothing until approval, then applies each", async () => {
    const fixture = await createFixtureOrg(db, { domain: "cleanup-flow.test" });
    const { old, drifting, fresh, decision } = await seed(fixture);

    const response = await runCleanup(fixture, (type, id) => {
      if (id === old.id) return [{ ...base, recordType: type, recordId: id, action: "close_completed", closingNote: "Report submitted in June." }];
      if (id === drifting.id)
        return [{ ...base, recordType: type, recordId: id, action: "replace", replacement: { title: "Decide: outsource vs buy rig", nextAction: "Get two quotes" } }];
      if (id === decision.id) return [{ ...base, recordType: type, recordId: id, action: "update_next_action", newNextAction: "Compare the two quotes" }];
      return [];
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recordsChecked: 3, proposals: 3, byAction: { close_completed: 1, replace: 1, update_next_action: 1 } });

    const rows = await db.select().from(suggestions).where(eq(suggestions.organizationId, fixture.org.id));
    const byTarget = new Map(rows.map((r) => [r.targetId, r]));
    expect(byTarget.get(old.id)).toMatchObject({
      changeType: "cleanup",
      status: "pending",
      proposedDiff: { status: "completed", latestUpdate: "Report submitted in June." },
      conflicts: [{ kind: "cleanup", classification: "likely_completed" }],
    });
    expect(byTarget.get(drifting.id)).toMatchObject({ changeType: "replace", conflicts: [{ kind: "cleanup", classification: "replaced_by_new_work" }] });
    expect(byTarget.get(decision.id)).toMatchObject({ changeType: "cleanup", proposedDiff: { suggestedNextStep: "Compare the two quotes" } });
    expect(byTarget.has(fresh.id)).toBe(false);
    const [untouched] = await db.select().from(tasks).where(eq(tasks.id, old.id));
    expect(untouched.status).toBe("active");

    // Running again while those are waiting proposes nothing new.
    const again = await runCleanup(fixture, (type, id) => [{ ...base, recordType: type, recordId: id, action: "confirm_active" }]);
    expect(again.json()).toMatchObject({ recordsChecked: 0, proposals: 0 });

    for (const row of rows) {
      await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: row.id, reviewerId: fixture.user.id });
    }
    const [closed] = await db.select().from(tasks).where(eq(tasks.id, old.id));
    expect(closed).toMatchObject({ status: "completed", latestUpdate: "Report submitted in June." });

    const [replaced] = await db.select().from(tasks).where(eq(tasks.id, drifting.id));
    expect(replaced.status).toBe("superseded");
    const [replacement] = await db.select().from(tasks).where(eq(tasks.id, replaced.supersededById!));
    expect(replacement).toMatchObject({ title: "Decide: outsource vs buy rig", nextAction: "Get two quotes", projectId: fixture.project.id, status: "active" });

    const [updatedDecision] = await db.select().from(decisions).where(eq(decisions.id, decision.id));
    expect(updatedDecision.suggestedNextStep).toBe("Compare the two quotes");

    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    expect(data.needsDisposition).toEqual([]);
    expect(data.decisionsNeeded[0].nextStepStale).toBe(false);
  });

  it("approving a bare 'still active' confirmation clears the stale flags without changing the record", async () => {
    const fixture = await createFixtureOrg(db, { domain: "cleanup-confirm.test" });
    const { old, drifting } = await seed(fixture);

    await runCleanup(fixture, (type, id) => (type === "task" ? [{ ...base, recordType: type, recordId: id, action: "confirm_active" }] : []));
    const rows = await db.select().from(suggestions).where(eq(suggestions.organizationId, fixture.org.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.changeType === "cleanup" && Object.keys(r.proposedDiff as object).length === 0)).toBe(true);
    for (const row of rows) {
      await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: row.id, reviewerId: fixture.user.id });
    }

    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    expect(data.needsDisposition).toEqual([]);
    const all = [...data.risks, ...data.operatingActions];
    expect(all.find((t) => t.id === drifting.id)!.nextActionStale).toBe(false);
    const [kept] = await db.select().from(tasks).where(eq(tasks.id, old.id));
    expect(kept).toMatchObject({ status: "active", nextAction: "Email program officer" });
  });

  it("routes 'covered by newer work' through the merge flow, and a replace on a closed task fails gracefully", async () => {
    const fixture = await createFixtureOrg(db, { domain: "cleanup-supersede.test" });
    const { old, drifting, fresh } = await seed(fixture);

    await runCleanup(fixture, (type, id) => {
      if (id === old.id) return [{ ...base, recordType: type, recordId: id, action: "supersede", supersededById: fresh.id }];
      if (id === drifting.id) return [{ ...base, recordType: type, recordId: id, action: "replace", replacement: { title: "New shape" } }];
      return [];
    });
    const rows = await db.select().from(suggestions).where(eq(suggestions.organizationId, fixture.org.id));
    const merge = rows.find((r) => r.targetId === old.id)!;
    expect(merge).toMatchObject({ changeType: "merge", proposedDiff: { supersededById: fresh.id }, conflicts: [{ kind: "cleanup", classification: "likely_superseded" }] });
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: merge.id, reviewerId: fixture.user.id });
    const [superseded] = await db.select().from(tasks).where(eq(tasks.id, old.id));
    expect(superseded).toMatchObject({ status: "superseded", supersededById: fresh.id });

    await db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, drifting.id));
    const replace = rows.find((r) => r.targetId === drifting.id)!;
    await expect(
      approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: replace.id, reviewerId: fixture.user.id }),
    ).rejects.toBeInstanceOf(SuggestionApplyError);
    const count = await db.select().from(tasks).where(eq(tasks.organizationId, fixture.org.id));
    expect(count).toHaveLength(3);
  });

  it("is scoped to the caller's organization", async () => {
    const mine = await createFixtureOrg(db, { domain: "cleanup-mine.test" });
    const theirs = await createFixtureOrg(db, { domain: "cleanup-theirs.test" });
    const { old } = await seed(theirs);
    const seen: string[] = [];
    await runCleanup(mine, (_type, id) => {
      seen.push(id);
      return [];
    });
    expect(seen).not.toContain(old.id);
    expect(await db.select().from(suggestions).where(eq(suggestions.organizationId, theirs.org.id))).toEqual([]);
  });
});
