import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, decisions, initiatives, objectives, projects, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { approveSuggestion } from "../suggestions/apply.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { loadFindingsContext, referencedRecords, splitIntoChunks } from "../interpretation/reviewFindings.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;

function toolUse(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

async function cookieFor(fixture: Fixture) {
  await db.update(authorizedUsers).set({ role: "admin" }).where(eq(authorizedUsers.id, fixture.authorization.id));
  return { [SESSION_COOKIE_NAME]: await signSession({ userId: fixture.user.id, organizationId: fixture.org.id, email: fixture.user.email, role: "admin" }) };
}

describe("review findings helpers", () => {
  it("splits long documents at headings/rows, in order, within the size limit", () => {
    const doc = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n${"x".repeat(900)}`).join("\n");
    const chunks = splitIntoChunks(doc, 5000);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 5000)).toBe(true);
    expect(chunks[0].startsWith("## Section 0")).toBe(true);
    expect(chunks.join("\n")).toContain("## Section 29");
  });

  it("finds records named by full link id or by an 8-character prefix", async () => {
    await truncateAll(db);
    const fixture = await createFixtureOrg(db, { domain: "findings-refs.test" });
    const [a] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "A" }).returning();
    const [b] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "B" }).returning();
    const ctx = await loadFindingsContext(db, fixture.org.id);
    const text = `See https://x.test/tasks/${a.id} and \`${b.id.slice(0, 8)}\`.`;
    expect(referencedRecords(text, ctx).map((r) => r.title).sort()).toEqual(["A", "B"]);
  });
});

describe("POST /api/reviews/findings", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("turns specific corrections into labelled proposals, drops anything invalid, and returns app feedback separately", async () => {
    const fixture = await createFixtureOrg(db, { domain: "findings-flow.test" });
    const [needle] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Needle size testing", description: "White pellet attributed to 18G use." })
      .returning();
    const [copy] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Needle testing (copy)" }).returning();
    const [clinical] = await db.insert(projects).values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Clinical sampling" }).returning();
    const [fast1] = await db.insert(decisions).values({ organizationId: fixture.org.id, title: "Fast Track Aim 1 path", decider: "Leadership" }).returning();
    const [fast2] = await db.insert(decisions).values({ organizationId: fixture.org.id, title: "Fast Track Aim 1 path (dup)", decider: "Leadership" }).returning();

    let prompt = "";
    const fake: ClaudeClient = {
      createMessage: async (params) => {
        if (params.tool_choice?.type === "tool" && params.tool_choice.name === "redact_text") {
          return toolUse("redact_text", { redactedText: String(params.messages[0].content) });
        }
        prompt = String(params.messages[0].content);
        return toolUse("propose_corrections", {
          changes: [
            {
              action: "update",
              finding: "C02",
              targetType: "task",
              targetId: needle.id,
              fields: { description: "18G attribution withdrawn; 21G may have been used; cause unresolved.", status: "not-a-status", organizationId: "evil", projectId: clinical.id },
              needsVerification: true,
              verifyNote: "Confirm the actual needle with Duke.",
              reasoning: "Newer evidence withdraws the 18G attribution.",
              confidence: 0.9,
            },
            { action: "update", targetType: "task", targetId: "11111111-1111-4111-8111-111111111111", fields: { title: "ghost" }, reasoning: "x", confidence: 0.9 },
            { action: "merge", finding: "C10", targetType: "decision", targetId: fast2.id, keepId: fast1.id, reasoning: "Duplicate Fast Track decision.", confidence: 0.85 },
            { action: "merge", targetType: "task", targetId: copy.id, keepId: copy.id, reasoning: "self", confidence: 0.9 },
            { action: "update", finding: "C01", targetType: "objective", targetId: fixture.objective.id, fields: { priority: "critical" }, reasoning: "Sampling is the first priority.", confidence: 0.8 },
            {
              action: "question",
              finding: "C01",
              question: { objectiveId: fixture.objective.id, title: "Can TMD reliably recover useful biological material?", label: "Clinical Sampling / White Pellet", taskIds: [needle.id, "bad"] },
              reasoning: "The brief implies this question.",
              confidence: 0.7,
            },
            { action: "create", targetType: "project", fields: { title: "Pathology / Explant", initiativeId: fixture.initiative.id }, reasoning: "C08 grouping.", confidence: 0.7 },
            { action: "create", targetType: "project", fields: { title: "Orphan" }, reasoning: "missing parent", confidence: 0.7 },
            { action: "create", targetType: "objective", fields: { title: "Advance clinical and regulatory readiness", owner: "Sean", description: "Keeps the EFS and FDA path moving." }, reasoning: "Reviewer asked for a new outcome.", confidence: 0.8 },
          ],
          appFeedback: [
            { area: "Dates", issue: "Date-only values render a day early", suggestion: "Treat as dates, not instants", priority: "must" },
            { area: "Dates", issue: "Date-only values render a day early", priority: "must" },
          ],
        });
      },
    };

    const app = await buildApp();
    setClaudeClientForTesting(fake);
    const cookies = await cookieFor(fixture);
    const doc = `## C. Accuracy corrections\n| C02 | [Needle](https://x.test/tasks/${needle.id}) | Replace 18G attribution. | Verify |`;
    const started = await app.inject({ method: "POST", url: "/api/reviews/findings", cookies, payload: { text: doc } });
    expect(started.statusCode).toBe(202);
    let job = started.json();
    for (let i = 0; i < 50 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await app.inject({ method: "GET", url: `/api/reviews/findings/${job.id}`, cookies })).json();
    }
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(job).toMatchObject({ status: "done", proposals: 6, needsVerification: 1, byKind: { update: 2, merge: 1, question: 1, create: 2 } });
    expect(job.appFeedback).toHaveLength(1);
    expect(prompt).toContain(`task id=${needle.id}`);
    expect(prompt).toContain("description: White pellet attributed to 18G use.");

    const rows = await db.select().from(suggestions).where(eq(suggestions.organizationId, fixture.org.id));
    const needleRow = rows.find((r) => r.targetId === needle.id)!;
    expect(needleRow.proposedDiff).toEqual({ description: "18G attribution withdrawn; 21G may have been used; cause unresolved.", projectId: clinical.id });
    expect(needleRow.confidence).toBe(0.6);
    expect(needleRow.reasoning).toBe("[C02] Newer evidence withdraws the 18G attribution. Verify: Confirm the actual needle with Duke.");
    expect(needleRow.conflicts).toEqual([{ kind: "review", finding: "C02", needsVerification: true, verifyNote: "Confirm the actual needle with Duke." }]);
    expect(rows.find((r) => r.changeType === "merge")).toMatchObject({ targetId: fast2.id, proposedDiff: { supersededById: fast1.id } });
    expect(rows.find((r) => r.changeType === "question")!.proposedDiff).toMatchObject({ taskIds: [needle.id], label: "Clinical Sampling / White Pellet" });
    expect(rows.find((r) => r.changeType === "new_task" && r.targetType === "project")!.proposedDiff).toEqual({ title: "Pathology / Explant", initiativeId: fixture.initiative.id });

    // Nothing changed until approval; approval applies the correction.
    const [before] = await db.select().from(tasks).where(eq(tasks.id, needle.id));
    expect(before.description).toBe("White pellet attributed to 18G use.");
    for (const row of rows) await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: row.id, reviewerId: fixture.user.id });
    const [after] = await db.select().from(tasks).where(eq(tasks.id, needle.id));
    expect(after).toMatchObject({ projectId: clinical.id, description: "18G attribution withdrawn; 21G may have been used; cause unresolved." });
    const [objective] = await db.select().from(objectives).where(eq(objectives.id, fixture.objective.id));
    expect(objective.priority).toBe("critical");
    const created = await db.select().from(objectives).where(eq(objectives.title, "Advance clinical and regulatory readiness"));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ organizationId: fixture.org.id, owner: "Sean", description: "Keeps the EFS and FDA path moving." });
    const [merged] = await db.select().from(decisions).where(eq(decisions.id, fast2.id));
    expect(merged.status).toBe("superseded");
  });

  it("never rewrites text on a record the AI wasn't shown in full, but still allows structural changes to it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "findings-safety.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "QMS", description: "Long original text that must survive." })
      .returning();
    const [other] = await db.insert(projects).values({ organizationId: fixture.org.id, initiativeId: fixture.initiative.id, title: "Quality" }).returning();
    const fake: ClaudeClient = {
      createMessage: async (params) =>
        params.tool_choice?.type === "tool"
          ? toolUse("redact_text", { redactedText: String(params.messages[0].content) })
          : toolUse("propose_corrections", {
              changes: [
                { action: "update", targetType: "task", targetId: task.id, fields: { description: "Only the new bit.", projectId: other.id }, reasoning: "r", confidence: 0.8 },
              ],
              appFeedback: [],
            }),
    };
    const app = await buildApp();
    setClaudeClientForTesting(fake);
    const cookies = await cookieFor(fixture);
    // The short title "QMS" isn't distinctive enough to count as naming it.
    let job = (await app.inject({ method: "POST", url: "/api/reviews/findings", cookies, payload: { text: "Move the QMS work under Quality." } })).json();
    for (let i = 0; i < 50 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await app.inject({ method: "GET", url: `/api/reviews/findings/${job.id}`, cookies })).json();
    }
    setClaudeClientForTesting(undefined);
    await app.close();
    const [row] = await db.select().from(suggestions).where(eq(suggestions.targetId, task.id));
    expect(row.proposedDiff).toEqual({ projectId: other.id });
  });

  it("files a task moved into an initiative, and reports what it couldn't act on instead of dropping it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "findings-initiative.test" });
    const [a, b] = await db
      .insert(tasks)
      .values([
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Kessel kickoff" },
        { organizationId: fixture.org.id, projectId: fixture.project.id, title: "Grant report" },
      ])
      .returning();
    // fixture.initiative holds exactly one project; this one holds none.
    const [empty] = await db.insert(initiatives).values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Kessel transfer" }).returning();
    const many = Array.from({ length: 62 }, (_, i) => ({ action: "update", targetType: "task", targetId: "22222222-2222-4222-8222-2222222222" + String(i).padStart(2, "0"), fields: { title: "x" }, reasoning: `ghost ${i}`, confidence: 0.9 }));
    setClaudeClientForTesting({
      createMessage: async (params) =>
        params.tool_choice?.type === "tool"
          ? toolUse("redact_text", { redactedText: String(params.messages[0].content) })
          : toolUse("propose_corrections", {
              changes: [
                { action: "update", targetType: "task", targetId: a.id, fields: { projectId: empty.id }, reasoning: "Kessel work.", confidence: 0.9 },
                { action: "update", targetType: "task", targetId: b.id, fields: { projectId: fixture.initiative.id }, reasoning: "Grant work.", confidence: 0.9 },
                ...many,
              ],
              unresolved: [{ text: 'Move "Old thing" into "Gone"', reason: "No project named Gone." }],
              appFeedback: [],
            }),
    });
    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    let job = (await app.inject({ method: "POST", url: "/api/reviews/findings", cookies, payload: { text: "Moves." } })).json();
    for (let i = 0; i < 50 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await app.inject({ method: "GET", url: `/api/reviews/findings/${job.id}`, cookies })).json();
    }
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(job.proposals).toBe(2);
    const reasons = job.unresolved.map((u: { reason: string }) => u.reason);
    expect(reasons).toContain("No project named Gone.");
    expect(reasons.filter((r: string) => r.startsWith("No record with that name"))).toHaveLength(58);
    expect(reasons.some((r: string) => r.startsWith("Over the limit of 60"))).toBe(true);

    const rows = await db.select().from(suggestions).where(eq(suggestions.organizationId, fixture.org.id));
    expect(rows.find((r) => r.targetId === a.id)!.proposedDiff).toEqual({ newParent: { title: "Kessel transfer", parentId: empty.id } });
    expect(rows.find((r) => r.targetId === b.id)!.proposedDiff).toEqual({ projectId: fixture.project.id });

    for (const row of rows) await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: row.id, reviewerId: fixture.user.id });
    const [created] = await db.select().from(projects).where(eq(projects.initiativeId, empty.id));
    expect(created.title).toBe("Kessel transfer");
    expect((await db.select().from(tasks).where(eq(tasks.id, a.id)))[0].projectId).toBe(created.id);
  });

  it("rejects an empty or oversized paste and hides other organizations' jobs", async () => {
    const mine = await createFixtureOrg(db, { domain: "findings-mine.test" });
    const theirs = await createFixtureOrg(db, { domain: "findings-theirs.test" });
    setClaudeClientForTesting({ createMessage: async () => toolUse("propose_corrections", { changes: [], appFeedback: [] }) });
    const app = await buildApp();
    expect((await app.inject({ method: "POST", url: "/api/reviews/findings", cookies: await cookieFor(mine), payload: { text: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/reviews/findings", cookies: await cookieFor(mine), payload: { text: "x".repeat(200_001) } })).statusCode).toBe(400);
    const started = (await app.inject({ method: "POST", url: "/api/reviews/findings", cookies: await cookieFor(mine), payload: { text: "Some finding" } })).json();
    const peek = await app.inject({ method: "GET", url: `/api/reviews/findings/${started.id}`, cookies: await cookieFor(theirs) });
    expect(peek.statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 200));
    setClaudeClientForTesting(undefined);
    await app.close();
  });
});
