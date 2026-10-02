import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog, authorizedUsers, decisions, milestones, risks, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { setClaudeClientForTesting } from "../interpretation/claudeClient.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;

async function as(f: Fixture, role: "admin" | "member") {
  await db.update(authorizedUsers).set({ role }).where(eq(authorizedUsers.id, f.authorization.id));
  return { [SESSION_COOKIE_NAME]: await signSession({ userId: f.user.id, organizationId: f.org.id, email: f.user.email, role }) };
}

describe("Executive Overview editing", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("creates and updates milestones; only an admin moves a committed baseline; links stay within the organization", async () => {
    const mine = await createFixtureOrg(db, { domain: "ms-mine.test" });
    const theirs = await createFixtureOrg(db, { domain: "ms-theirs.test" });
    const [task] = await db.insert(tasks).values({ organizationId: mine.org.id, projectId: mine.project.id, title: "Aged domes", status: "blocked" }).returning();
    const [hidden] = await db
      .insert(tasks)
      .values({ organizationId: mine.org.id, projectId: mine.project.id, title: "Secret", status: "active", visibility: "restricted" })
      .returning();
    const in60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const app = await buildApp();
    const member = await as(mine, "member");

    const created = await app.inject({
      method: "POST",
      url: "/api/milestones",
      cookies: member,
      payload: { objectiveId: mine.objective.id, title: "Verification complete", baselineDate: "2026-12-01", confidence: "committed" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().milestone.id;
    expect(created.json().milestone.baselineDate).toBe("2026-12-01T00:00:00.000Z");

    const foreignObjective = await app.inject({ method: "POST", url: "/api/milestones", cookies: member, payload: { objectiveId: theirs.objective.id, title: "x" } });
    const noTitle = await app.inject({ method: "POST", url: "/api/milestones", cookies: member, payload: { objectiveId: mine.objective.id } });
    const badDate = await app.inject({ method: "PATCH", url: `/api/milestones/${id}`, cookies: member, payload: { forecastDate: "next week" } });
    const memberMovesBaseline = await app.inject({ method: "PATCH", url: `/api/milestones/${id}`, cookies: member, payload: { baselineDate: "2027-01-01" } });
    const memberForecast = await app.inject({ method: "PATCH", url: `/api/milestones/${id}`, cookies: member, payload: { forecastDate: in60 } });
    expect([foreignObjective.statusCode, noTitle.statusCode, badDate.statusCode, memberMovesBaseline.statusCode, memberForecast.statusCode]).toEqual([404, 400, 400, 403, 200]);

    const linkOk = await app.inject({ method: "POST", url: `/api/milestones/${id}/links`, cookies: member, payload: { entityType: "task", entityId: task.id } });
    await app.inject({ method: "POST", url: `/api/milestones/${id}/links`, cookies: member, payload: { entityType: "task", entityId: hidden.id } });
    const linkForeign = await app.inject({ method: "POST", url: `/api/milestones/${id}/links`, cookies: member, payload: { entityType: "project", entityId: theirs.project.id } });
    expect([linkOk.statusCode, linkForeign.statusCode]).toEqual([201, 404]);

    const detail = (await app.inject({ method: "GET", url: `/api/overview/outcomes/${mine.objective.id}`, cookies: member })).json();
    expect(detail.milestones[0].links.map((l: { title: string }) => l.title)).toEqual(["Aged domes"]);
    expect(detail.blockedTasks).toEqual([{ id: task.id, title: "Aged domes" }]);
    expect((await app.inject({ method: "GET", url: `/api/overview/outcomes/${mine.objective.id}`, cookies: await as(theirs, "admin") })).statusCode).toBe(404);

    const overview = (await app.inject({ method: "GET", url: "/api/overview", cookies: member })).json();
    expect(overview.attention.map((i: { title: string }) => i.title)).toContain("Blocked: Aged domes");
    expect(overview.outcomes[0].nextMilestone).toMatchObject({ title: "Verification complete", date: in60 });

    const admin = await as(mine, "admin");
    const adminMoves = await app.inject({ method: "PATCH", url: `/api/milestones/${id}`, cookies: admin, payload: { baselineDate: "2027-01-01" } });
    const achieved = await app.inject({ method: "PATCH", url: `/api/milestones/${id}`, cookies: admin, payload: { state: "achieved" } });
    expect([adminMoves.statusCode, achieved.statusCode]).toEqual([200, 200]);
    expect(achieved.json().milestone.actualDate).toMatch(/T00:00:00.000Z$/);

    const linkId = detail.milestones[0].links[0].id;
    const unlinked = await app.inject({ method: "DELETE", url: `/api/milestones/${id}/links/${linkId}`, cookies: admin });
    expect(unlinked.body).toBe("{\"ok\":true}");
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id))).length).toBe(1);
    await app.close();

    const audit = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["milestone.created", "milestone.updated", "milestone.linked", "milestone.unlinked"]));
  });

  it("records risks against an outcome's own milestones and closes rather than deletes them", async () => {
    const mine = await createFixtureOrg(db, { domain: "risk-mine.test" });
    const [other] = await db
      .insert(milestones)
      .values({ organizationId: mine.org.id, objectiveId: (await createFixtureOrg(db, { domain: "risk-other.test" })).objective.id, title: "Elsewhere" })
      .returning();
    const [own] = await db.insert(milestones).values({ organizationId: mine.org.id, objectiveId: mine.objective.id, title: "Own" }).returning();
    const app = await buildApp();
    const member = await as(mine, "member");
    const wrongMilestone = await app.inject({ method: "POST", url: "/api/risks", cookies: member, payload: { objectiveId: mine.objective.id, title: "x", milestoneId: other.id } });
    const created = await app.inject({
      method: "POST",
      url: "/api/risks",
      cookies: member,
      payload: { objectiveId: mine.objective.id, title: "Single supplier", milestoneId: own.id, escalation: "decision_needed", mitigation: "Second source" },
    });
    expect([wrongMilestone.statusCode, created.statusCode]).toEqual([404, 201]);
    const closed = await app.inject({ method: "PATCH", url: `/api/risks/${created.json().risk.id}`, cookies: member, payload: { status: "closed" } });
    expect(closed.statusCode).toBe(200);
    const overview = (await app.inject({ method: "GET", url: "/api/overview", cookies: member })).json();
    await app.close();
    expect(overview.openRiskTotal).toBe(0);
    expect(await db.select().from(risks)).toHaveLength(1);
  });

  it("sets a decision's outcome, recommendation and cost of delay, respecting visibility", async () => {
    const mine = await createFixtureOrg(db, { domain: "dec-mine.test" });
    const theirs = await createFixtureOrg(db, { domain: "dec-theirs.test" });
    const [open] = await db.insert(decisions).values({ organizationId: mine.org.id, title: "Pick partner", decider: "CEO", dueDate: new Date(Date.now() + 3 * 86400000) }).returning();
    const [secret] = await db.insert(decisions).values({ organizationId: mine.org.id, title: "Board", decider: "Board", visibility: "leadership" }).returning();
    const app = await buildApp();
    const member = await as(mine, "member");
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/decisions/${open.id}/overview`,
      cookies: member,
      payload: { objectiveId: mine.objective.id, recommendation: "Duke", impactOfDelay: "Study start slips to Q2" },
    });
    const foreignObjective = await app.inject({ method: "PATCH", url: `/api/decisions/${open.id}/overview`, cookies: member, payload: { objectiveId: theirs.objective.id } });
    const hidden = await app.inject({ method: "PATCH", url: `/api/decisions/${secret.id}/overview`, cookies: member, payload: { recommendation: "x" } });
    expect([ok.statusCode, foreignObjective.statusCode, hidden.statusCode]).toEqual([200, 404, 404]);
    const overview = (await app.inject({ method: "GET", url: "/api/overview", cookies: member })).json();
    await app.close();
    expect(overview.attention[0]).toMatchObject({ title: "Pick partner", recommendation: "Duke", impactOfDelay: "Study start slips to Q2", objectiveId: mine.objective.id });
    expect(overview.outcomes[0].decisionsNeeded).toBe(1);
  });

  it("publishes a reporting period (admin only), then shows what changed since; drafts the paragraph from the overview", async () => {
    const mine = await createFixtureOrg(db, { domain: "pub-mine.test" });
    const app = await buildApp();
    const member = await as(mine, "member");
    expect((await app.inject({ method: "POST", url: "/api/overview/publish", cookies: member, payload: { narrative: "x" } })).statusCode).toBe(403);
    const admin = await as(mine, "admin");
    expect((await app.inject({ method: "POST", url: "/api/overview/publish", cookies: admin, payload: { narrative: "  " } })).statusCode).toBe(400);

    let prompt = "";
    setClaudeClientForTesting({
      createMessage: async (params) => {
        prompt = JSON.stringify(params.messages);
        return { content: [{ type: "tool_use", id: "t", name: "draft_summary", input: { paragraph: "Exvade is proving reliable sampling." } }] } as unknown as Anthropic.Message;
      },
    });
    const draft = await app.inject({ method: "POST", url: "/api/overview/draft-narrative", cookies: admin });
    setClaudeClientForTesting(undefined);
    expect(draft.json()).toEqual({ draft: "Exvade is proving reliable sampling." });
    expect(prompt).toContain(mine.objective.title);

    const published = await app.inject({ method: "POST", url: "/api/overview/publish", cookies: admin, payload: { narrative: "Exvade is proving reliable sampling." } });
    expect(published.statusCode).toBe(201);
    await app.inject({ method: "PUT", url: `/api/objectives/${mine.objective.id}/health`, cookies: admin, payload: { health: "at_risk", rationale: "Supplier" } });
    const overview = (await app.inject({ method: "GET", url: "/api/overview", cookies: member })).json();
    await app.close();
    expect(overview.narrative).toBe("Exvade is proving reliable sampling.");
    expect(overview.changes).toEqual([{ kind: "health", title: mine.objective.title, before: "Not assessed", after: "At risk", objectiveId: mine.objective.id }]);
  });
});
