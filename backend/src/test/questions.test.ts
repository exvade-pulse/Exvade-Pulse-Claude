import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, decisions, strategicQuestionLinks, strategicQuestions, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { approveSuggestion } from "../suggestions/apply.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { proposeQuestions, type QuestionContext } from "../interpretation/questionDetection.js";
import { createQuestion, linkToQuestion, QuestionError, reopenQuestion, resolveQuestion } from "../questions/manage.js";
import { buildExecutiveReviewData, renderExecutiveReviewText } from "../reports/executiveReview.js";
import { diffReviews, summarizeReview } from "../reports/reviewChanges.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;

function toolUseMessage(input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name: "propose_strategic_questions", input }] } as unknown as Anthropic.Message;
}

async function cookieFor(fixture: Fixture, role: "admin" | "member" = "admin") {
  // The server reads the role from authorized_users on every request.
  await db.update(authorizedUsers).set({ role }).where(eq(authorizedUsers.id, fixture.authorization.id));
  return {
    [SESSION_COOKIE_NAME]: await signSession({ userId: fixture.user.id, organizationId: fixture.org.id, email: fixture.user.email, role }),
  };
}

async function seedWork(fixture: Fixture) {
  const [gauge] = await db
    .insert(tasks)
    .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Needle gauge testing", status: "blocked" })
    .returning();
  const [pellet] = await db
    .insert(tasks)
    .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Pellet analysis", status: "active" })
    .returning();
  const [needle] = await db
    .insert(decisions)
    .values({ organizationId: fixture.org.id, title: "Change needle size from 20G?", decider: "Don" })
    .returning();
  const [broad] = await db
    .insert(decisions)
    .values({ organizationId: fixture.org.id, title: "Highest-value clinical use case and fastest path to exit?", decider: "Leadership", stakeholders: ["Board"] })
    .returning();
  return { gauge, pellet, needle, broad };
}

const OBJ = "11111111-1111-4111-8111-111111111111";
const DEC = "22222222-2222-4222-8222-222222222222";
const BROAD = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const context: QuestionContext = {
  objectives: [{ id: OBJ, title: "Advance device", description: null }],
  decisions: [
    { id: DEC, title: "Change needle size?", whyItMatters: null, decider: "Don", status: "open" },
    { id: BROAD, title: "Use case and exit path?", whyItMatters: null, decider: "Leadership", status: "open" },
  ],
  projects: [],
  tasks: [{ id: TASK, title: "Needle gauge testing", project: "Bench", status: "active", nextAction: null }],
  existingQuestions: [{ title: "Can we manufacture at scale?", objective: "Advance device" }],
};
const base = { objectiveId: OBJ, reasoning: "Several records bear on it.", confidence: 0.8 };

describe("proposeQuestions", () => {
  it("keeps grounded proposals and drops unknown ids, repeats, empty questions and double conversions", async () => {
    const fake: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage({
          questions: [
            { ...base, title: "Can we sample reliably enough?", hypothesis: "Yes at 18G", decisionIds: [DEC, "99999999-9999-4999-8999-999999999999"], taskIds: [TASK] },
            { ...base, title: "Can we manufacture at scale??", taskIds: [TASK] },
            { ...base, objectiveId: "99999999-9999-4999-8999-999999999999", title: "Elsewhere?", taskIds: [TASK] },
            { ...base, title: "Nothing linked?" },
            { ...base, title: "Just one decision?", decisionIds: [DEC] },
            { ...base, title: "Which clinical use case and exit path?", convertDecisionId: BROAD, newDecisions: [{ title: "Which use case first?" }, { title: "Which exit path?", decider: "Board" }] },
            { ...base, title: "Exit path again?", convertDecisionId: BROAD, newDecisions: [{ title: "x" }] },
            // Malformed: dropped on its own, without losing the others.
            { ...base, title: 5 },
            // Lists given as null are fine.
            { ...base, title: "Can we hit volume targets?", decisionIds: [DEC], taskIds: [TASK], projectIds: null, newDecisions: null },
          ],
        }),
    };
    const { proposals: result, skipped } = await proposeQuestions(context, fake);
    expect(result.map((q) => q.title)).toEqual(["Can we sample reliably enough?", "Which clinical use case and exit path?", "Can we hit volume targets?"]);
    expect(skipped).toEqual({ noAnswer: false, malformed: 1, unknownObjective: 1, alreadyExists: 1, tooFewLinks: 3 });
    expect(result[0]).toMatchObject({ decisionIds: [DEC], taskIds: [TASK], hypothesis: "Yes at 18G", convertDecisionId: null, newDecisions: [] });
    expect(result[1]).toMatchObject({
      convertDecisionId: BROAD,
      newDecisions: [
        { title: "Which use case first?", decider: null },
        { title: "Which exit path?", decider: "Board" },
      ],
    });
  });
});

describe("strategic questions", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("resolving records the answer but leaves the question's decisions open, and reports them", async () => {
    const fixture = await createFixtureOrg(db, { domain: "q-resolve.test" });
    const { needle, gauge } = await seedWork(fixture);
    const q = await createQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, objectiveId: fixture.objective.id, title: "Can we sample reliably?" });
    await linkToQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, entityType: "decision", entityId: needle.id });
    await linkToQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, entityType: "task", entityId: gauge.id });
    // Linking twice is harmless.
    await linkToQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, entityType: "task", entityId: gauge.id });
    expect(await db.select().from(strategicQuestionLinks).where(eq(strategicQuestionLinks.questionId, q.id))).toHaveLength(2);

    const result = await resolveQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, resolution: "Yes, at 18G." });
    expect(result.question).toMatchObject({ status: "resolved", resolution: "Yes, at 18G." });
    expect(result.openDecisions.map((d) => d.title)).toEqual(["Change needle size from 20G?"]);
    const [still] = await db.select().from(decisions).where(eq(decisions.id, needle.id));
    expect(still.status).toBe("open");

    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    expect(data.questions).toMatchObject([{ title: "Can we sample reliably?", state: "resolved", needsCloseOut: true }]);
    expect(data.focus.some((f) => f.kind === "question" && f.detail.startsWith("Resolved, but 1 decision under it is still open"))).toBe(true);

    await expect(resolveQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, resolution: "again" })).rejects.toThrow("already resolved");
    const reopened = await reopenQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id });
    expect(reopened.status).toBe("open");
  });

  it("never links across organizations", async () => {
    const mine = await createFixtureOrg(db, { domain: "q-mine.test" });
    const theirs = await createFixtureOrg(db, { domain: "q-theirs.test" });
    const { needle } = await seedWork(theirs);
    const q = await createQuestion(db, { organizationId: mine.org.id, actorId: mine.user.id, objectiveId: mine.objective.id, title: "Mine?" });
    await expect(
      linkToQuestion(db, { organizationId: mine.org.id, actorId: mine.user.id, questionId: q.id, entityType: "decision", entityId: needle.id }),
    ).rejects.toBeInstanceOf(QuestionError);
    await expect(
      createQuestion(db, { organizationId: mine.org.id, actorId: mine.user.id, objectiveId: theirs.objective.id, title: "Theirs?" }),
    ).rejects.toThrow("Objective not found");
  });

  it("rolls a question up in the executive review from its linked decisions and work", async () => {
    const fixture = await createFixtureOrg(db, { domain: "q-exec.test" });
    const { needle, gauge, pellet } = await seedWork(fixture);
    const before = summarizeReview(await buildExecutiveReviewData(fixture.org.id, "admin"));
    const q = await createQuestion(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      objectiveId: fixture.objective.id,
      title: "Can we sample reliably enough?",
      hypothesis: "Aspiration at 18–20G is enough.",
    });
    for (const [entityType, entityId] of [["decision", needle.id], ["project", fixture.project.id]] as const) {
      await linkToQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, entityType, entityId });
    }

    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    expect(data.questions).toHaveLength(1);
    const rolled = data.questions[0];
    expect(rolled).toMatchObject({
      state: "needs attention",
      objective: fixture.objective.title,
      hypothesis: "Aspiration at 18–20G is enough.",
      openDecisions: [{ title: "Change needle size from 20G?", overdue: false }],
      counts: { blocked: 1, needsAttention: 0, waiting: 0, active: 1 },
      needsCloseOut: false,
    });
    expect(rolled.work.map((w) => w.title)).toEqual(expect.arrayContaining([gauge.title, pellet.title]));
    expect(data.decisionsNeeded.find((d) => d.id === needle.id)!.questions).toEqual(["Can we sample reliably enough?"]);
    expect(data.headline).toContain("1 strategic question is open (1 needs attention)");
    expect(data.focus[0]).toMatchObject({ kind: "question", title: "Can we sample reliably enough?" });

    const text = renderExecutiveReviewText(data);
    expect(text.indexOf("STRATEGIC QUESTIONS")).toBeLessThan(text.indexOf("1. DECISIONS NEEDED"));
    expect(text).toContain("- Can we sample reliably enough? — needs attention (1 open decision, 1 blocked, 1 active) [");
    expect(text).toContain("Working hypothesis: Aspiration at 18–20G is enough.");
    expect(text).toContain("Part of strategic question: Can we sample reliably enough?");
    expect(diffReviews(before, summarizeReview(data)).map((c) => c.kind)).toContain("NEW_QUESTION");
  });

  it("a member's review neither shows nor counts a restricted decision under a question", async () => {
    const fixture = await createFixtureOrg(db, { domain: "q-member.test" });
    const { needle } = await seedWork(fixture);
    await db.update(decisions).set({ visibility: "leadership" }).where(eq(decisions.id, needle.id));
    const q = await createQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, objectiveId: fixture.objective.id, title: "Secret-ish?" });
    await linkToQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, entityType: "decision", entityId: needle.id });

    const member = await buildExecutiveReviewData(fixture.org.id, "member");
    expect(member.questions[0]).toMatchObject({ openDecisions: [], state: "on track" });
    expect(JSON.stringify(member)).not.toContain(needle.title);
  });
});

describe("question routes", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("the AI first pass proposes questions to Review; approving one creates it with its links", async () => {
    const fixture = await createFixtureOrg(db, { domain: "q-suggest.test" });
    const { needle, gauge, broad } = await seedWork(fixture);
    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () =>
        toolUseMessage({
          questions: [
            { objectiveId: fixture.objective.id, title: "Can we sample reliably enough?", hypothesis: "Probably at 18G", decisionIds: [needle.id], taskIds: [gauge.id], reasoning: "r", confidence: 0.8 },
            {
              objectiveId: fixture.objective.id,
              title: "What clinical use case and exit path should we pursue?",
              convertDecisionId: broad.id,
              newDecisions: [{ title: "Which clinical use case first?" }, { title: "Which exit path?", decider: "Board" }],
              reasoning: "The decision bundles two separate choices.",
              confidence: 0.7,
            },
          ],
        }),
    });
    const response = await app.inject({ method: "POST", url: "/api/questions/suggest", cookies: await cookieFor(fixture) });
    setClaudeClientForTesting(undefined);
    expect(response.json()).toMatchObject({ objectivesChecked: 1, questionsProposed: 2, conversionsProposed: 1, alreadyPending: 0, existingQuestions: 0, skipped: { noAnswer: false } });
    expect(await db.select().from(strategicQuestions)).toHaveLength(0);

    const list = await app.inject({ method: "GET", url: "/api/suggestions", cookies: await cookieFor(fixture) });
    const cards = list.json().suggestions.filter((s: { changeType: string }) => s.changeType === "question");
    expect(cards).toHaveLength(2);
    const conversion = cards.find((s: { questionDetails: { convertDecision: string | null } }) => s.questionDetails.convertDecision);
    expect(conversion.questionDetails).toEqual({
      objective: fixture.objective.title,
      decisions: [],
      tasks: [],
      projects: [],
      convertDecision: broad.title,
    });
    const simple = cards.find((s: { id: string }) => s.id !== conversion.id);
    expect(simple.questionDetails).toMatchObject({ decisions: [needle.title], tasks: [gauge.title] });

    for (const card of cards) {
      await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: card.id, reviewerId: fixture.user.id });
    }
    const created = await db.select().from(strategicQuestions).where(eq(strategicQuestions.organizationId, fixture.org.id));
    expect(created.map((q) => q.title).sort()).toEqual(["Can we sample reliably enough?", "What clinical use case and exit path should we pursue?"]);

    const [converted] = await db.select().from(decisions).where(eq(decisions.id, broad.id));
    expect(converted.status).toBe("superseded");
    expect(converted.resolution).toContain('Became the strategic question "What clinical use case and exit path should we pursue?"');
    const split = await db.select().from(decisions).where(eq(decisions.organizationId, fixture.org.id));
    expect(split.find((d) => d.title === "Which exit path?")).toMatchObject({ decider: "Board", status: "open" });
    expect(split.find((d) => d.title === "Which clinical use case first?")).toMatchObject({ decider: "Leadership", stakeholders: ["Board"] });

    const questionsRes = await app.inject({ method: "GET", url: "/api/questions", cookies: await cookieFor(fixture) });
    const conv = questionsRes.json().questions.find((q: { title: string }) => q.title.startsWith("What clinical"));
    expect(conv.links.map((l: { title: string }) => l.title).sort()).toEqual([broad.title, "Which clinical use case first?", "Which exit path?"].sort());
    // Approved question suggestions show up as recent developments without
    // breaking the review (regression: naming an unknown record type crashed it).
    const review = await buildExecutiveReviewData(fixture.org.id, "admin");
    expect(review.recentDevelopments.map((d) => d.about)).toContain("Strategic question: Can we sample reliably enough?");
    await app.close();
  });

  it("creates, links, resolves and unlinks over HTTP, and hides a member's view of restricted links", async () => {
    const fixture = await createFixtureOrg(db, { domain: "q-http.test" });
    const { needle, pellet } = await seedWork(fixture);
    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    const created = await app.inject({ method: "POST", url: "/api/questions", cookies, payload: { objectiveId: fixture.objective.id, title: "Is the pellet informative?" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().question.id;

    expect((await app.inject({ method: "POST", url: `/api/questions/${id}/links`, cookies, payload: { entityType: "task", entityId: pellet.id } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/questions/${id}/links`, cookies, payload: { entityType: "decision", entityId: needle.id } })).statusCode).toBe(201);
    await db.update(decisions).set({ visibility: "leadership" }).where(eq(decisions.id, needle.id));

    const memberView = await app.inject({ method: "GET", url: "/api/questions", cookies: await cookieFor(fixture, "member") });
    expect(memberView.json().questions[0].links.map((l: { title: string }) => l.title)).toEqual([pellet.title]);
    expect(JSON.stringify(memberView.json())).not.toContain(needle.title);

    const memberResolve = await app.inject({ method: "POST", url: `/api/questions/${id}/resolve`, cookies: await cookieFor(fixture, "member"), payload: { resolution: "Yes" } });
    expect(memberResolve.json().openDecisions).toEqual([]);
    await app.inject({ method: "POST", url: `/api/questions/${id}/reopen`, cookies: await cookieFor(fixture) });
    const resolved = await app.inject({ method: "POST", url: `/api/questions/${id}/resolve`, cookies, payload: { resolution: "Yes" } });
    expect(resolved.json().openDecisions.map((d: { title: string }) => d.title)).toEqual([needle.title]);
    expect((await app.inject({ method: "POST", url: `/api/questions/${id}/resolve`, cookies, payload: { resolution: "Yes" } })).statusCode).toBe(409);

    expect((await app.inject({ method: "DELETE", url: `/api/questions/${id}/links/task/${pellet.id}`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/questions/${id}/links/task/${pellet.id}`, cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/questions/not-a-uuid/resolve", cookies, payload: { resolution: "x" } })).statusCode).toBe(404);
    await app.close();
  });

  it("hides a question proposal involving a restricted record from a member's Review queue", async () => {
    const fixture = await createFixtureOrg(db, { domain: "q-hidden.test" });
    const { needle } = await seedWork(fixture);
    await db.update(decisions).set({ visibility: "leadership" }).where(eq(decisions.id, needle.id));
    await db.insert(suggestions).values({
      organizationId: fixture.org.id,
      sourceId: fixture.source.id,
      targetType: "question",
      targetId: null,
      changeType: "question",
      proposedDiff: { objectiveId: fixture.objective.id, title: "Q?", decisionIds: [needle.id], taskIds: [], projectIds: [], convertDecisionId: null, newDecisions: [] },
      reasoning: "r",
      confidence: 0.5,
    });
    const app = await buildApp();
    const member = await app.inject({ method: "GET", url: "/api/suggestions", cookies: await cookieFor(fixture, "member") });
    const admin = await app.inject({ method: "GET", url: "/api/suggestions", cookies: await cookieFor(fixture, "admin") });
    await app.close();
    expect(member.json().suggestions.filter((s: { changeType: string }) => s.changeType === "question")).toHaveLength(0);
    expect(admin.json().suggestions.filter((s: { changeType: string }) => s.changeType === "question")).toHaveLength(1);
  });
});

