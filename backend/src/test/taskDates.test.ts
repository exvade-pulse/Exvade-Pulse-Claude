import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { authorizedUsers, sources, suggestions, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { approveSuggestion } from "../suggestions/apply.js";
import { interpretSource, type CompanyContext } from "../interpretation/interpret.js";
import { buildExecutiveReviewData, renderExecutiveReviewText } from "../reports/executiveReview.js";
import { buildDashboard } from "../reports/dashboard.js";
import { createQuestion, linkToQuestion } from "../questions/manage.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;
const DAY = 24 * 60 * 60 * 1000;
// A calendar date n days from today (UTC), as the app stores due dates.
const dateIn = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + n * DAY);
const isoDay = (n: number) => dateIn(n).toISOString().slice(0, 10);

async function cookieFor(fixture: Fixture) {
  await db.update(authorizedUsers).set({ role: "admin" }).where(eq(authorizedUsers.id, fixture.authorization.id));
  return { [SESSION_COOKIE_NAME]: await signSession({ userId: fixture.user.id, organizationId: fixture.org.id, email: fixture.user.email, role: "admin" }) };
}

const viewer = (fixture: Fixture) => ({ userId: fixture.user.id, name: "Sean Meehan", email: "sean@exvade.test", role: "admin" as const });

describe("task dates and waiting-on", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("approving a dated update stores the calendar date and its type; bad values are dropped", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dates-approve.test" });
    const [task] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Dome aging" }).returning();
    const [source] = await db
      .insert(sources)
      .values({ organizationId: fixture.org.id, type: "gmail", externalId: randomUUID(), receivedAt: new Date(), rawBody: "x" })
      .returning();
    const [good] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: source.id,
        targetType: "task",
        targetId: task.id,
        changeType: "operational_update",
        proposedDiff: { dueDate: "2026-10-14", dueDateType: "planned", dueLabel: "Aged domes available", waitingFor: "Biomerics: aged domes" },
        reasoning: "r",
        confidence: 0.9,
      })
      .returning();
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: good.id, reviewerId: fixture.user.id });
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after.dueDate?.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(after).toMatchObject({ dueDateType: "planned", dueLabel: "Aged domes available", waitingFor: "Biomerics: aged domes" });

    const [bad] = await db
      .insert(suggestions)
      .values({
        organizationId: fixture.org.id,
        sourceId: source.id,
        targetType: "task",
        targetId: task.id,
        changeType: "operational_update",
        proposedDiff: { dueDate: "next Tuesday", dueDateType: "definitely", latestUpdate: "Moving along." },
        reasoning: "r",
        confidence: 0.9,
      })
      .returning();
    await approveSuggestion(db, { organizationId: fixture.org.id, suggestionId: bad.id, reviewerId: fixture.user.id });
    const [again] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(again.dueDate?.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(again).toMatchObject({ dueDateType: "planned", latestUpdate: "Moving along." });
  });

  it("the AI can't set a task date without quoting the source", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = { objectives: [], initiatives: [], projects: [], tasks: [{ id: taskId, title: "Dome aging", status: "active" }], decisions: [] };
    const reply = (input: unknown) => ({ createMessage: async () => ({ content: [{ type: "tool_use", id: "t", name: "propose_suggestion", input }] }) as unknown as Anthropic.Message });
    const body = "Aged domes should be available October 14.";
    const src = { subject: "Domes", from: "x@y.test", body, receivedAt: new Date("2026-09-29T00:00:00Z") };
    const base = { changeType: "operational_update", targetType: "task", targetId: taskId, reasoning: "r", confidence: 0.8 };
    const diff = { dueDate: "2026-10-14", dueDateType: "planned", dueLabel: "Aged domes available", latestUpdate: "Aging under way." };

    const unquoted = await interpretSource(src, context, reply({ ...base, proposedDiff: diff }));
    expect(unquoted[0].proposedDiff).toEqual({ latestUpdate: "Aging under way." });
    const quoted = await interpretSource(src, context, reply({ ...base, proposedDiff: diff, evidenceQuotes: ["available October 14"] }));
    expect(quoted[0].proposedDiff).toEqual(diff);
  });

  it("a person can set and clear dates and waiting-on directly on the task", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dates-direct.test" });
    const other = await createFixtureOrg(db, { domain: "dates-other.test" });
    const [task] = await db.insert(tasks).values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Advisor meeting" }).returning();
    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    const set = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/schedule`,
      cookies,
      payload: { dueDate: "2026-10-09", dueDateType: "confirmed", dueLabel: "Advisor meeting", waitingFor: "Sandy: deck draft", followUpOn: "2026-10-01" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().task).toMatchObject({ dueDateType: "confirmed", dueLabel: "Advisor meeting", waitingFor: "Sandy: deck draft" });
    const [stored] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(Object.keys(stored.fieldEvidence as object).sort()).toEqual(["dueDate", "waitingFor"]);

    const cleared = await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}/schedule`, cookies, payload: { dueDate: null } });
    expect(cleared.json().task).toMatchObject({ dueDate: null, dueDateType: null, dueLabel: null, waitingFor: "Sandy: deck draft" });

    const foreign = await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}/schedule`, cookies: await cookieFor(other), payload: { dueDate: "2026-10-09" } });
    expect(foreign.statusCode).toBe(404);
    await app.close();
  });

  it("task dates drive upcoming deadlines, key dates and outcome checks; waiting-for shows as waiting", async () => {
    const fixture = await createFixtureOrg(db, { domain: "dates-dashboard.test" });
    const [domes] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Dome aging", dueDate: dateIn(5), dueDateType: "planned", dueLabel: "Aged domes available" })
      .returning();
    const [trademark] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Japan trademark response", dueDate: dateIn(-4), dueDateType: "confirmed", dueLabel: "JPO response due" })
      .returning();
    const [slides] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Explant IHC", waitingFor: "Duke pathology: scanned slides", followUpOn: dateIn(-1) })
      .returning();
    const q = await createQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, objectiveId: fixture.objective.id, title: "Needle validation?" });
    await linkToQuestion(db, { organizationId: fixture.org.id, actorId: fixture.user.id, questionId: q.id, entityType: "task", entityId: domes.id });

    const data = await buildExecutiveReviewData(fixture.org.id, "admin");
    const dash = await buildDashboard(fixture.org.id, data, viewer(fixture), null);

    expect(dash.upcomingDeadlines).toEqual([
      expect.objectContaining({ kind: "task", id: domes.id, label: "Aged domes available", dateType: "planned", daysAway: 5, date: isoDay(5) + "T00:00:00.000Z" }),
    ]);
    expect(dash.priorities[0]).toMatchObject({ state: "upcoming deadline", keyDate: { dateType: "planned", label: "Aged domes available (Dome aging)" } });
    expect(data.pastDue.map((t) => t.id)).toEqual([trademark.id]);
    expect(data.headline).toContain("1 task date has passed with no outcome recorded — confirm what happened");
    const waitingItem = dash.waiting.find((w) => w.id === slides.id)!;
    expect(waitingItem.detail).toContain("on Duke pathology: scanned slides");
    expect(waitingItem.detail).toContain("follow-up is due");

    const text = renderExecutiveReviewText(data, dash);
    expect(text).toContain("(5 days, planned): Aged domes available (Dome aging)");
  });
});
