import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { decisions, sources, suggestions, tasks, webhookIntegrations } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { NOISE_FILTER_MODEL } from "../interpretation/noiseFilter.js";
import { generateIntegrationToken, revokeIntegrationToken } from "../integrations/manage.js";
import { CHATGPT_DAILY_COMMENT_LIMIT } from "../routes/chatgpt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

type Fixture = Awaited<ReturnType<typeof createFixtureOrg>>;

async function chatGptKeyFor(fixture: Fixture): Promise<string> {
  const generated = await generateIntegrationToken(db, {
    organizationId: fixture.org.id,
    actorId: fixture.user.id,
    type: "chatgpt",
  });
  return generated.rawToken;
}

function bearer(key: string) {
  return { authorization: `Bearer ${key}` };
}

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

// Redaction passes text through, the noise filter says "real content", and
// interpretation proposes a status change on the given task.
function statusUpdateClient(taskId: string): ClaudeClient {
  return {
    createMessage: async (params) => {
      if (params.tool_choice?.type === "tool" && params.tool_choice.name === "redact_text") {
        return toolUseMessage("redact_text", { redactedText: params.messages[0]?.content as string });
      }
      if (params.model === NOISE_FILTER_MODEL) {
        return toolUseMessage("classify_source", { isNoise: false, reason: "Real status update." });
      }
      return toolUseMessage("propose_suggestion", {
        changeType: "operational_update",
        targetType: "task",
        targetId: taskId,
        proposedDiff: { status: "blocked", latestUpdate: "Vendor hasn't replied in three weeks." },
        reasoning: "Comment says the task is stuck on the vendor.",
        confidence: 0.8,
      });
    },
  };
}

describe("GET /api/public/chatgpt/openapi.json", () => {
  it("is served without a key and marks sending a comment as consequential", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/public/chatgpt/openapi.json" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const spec = response.json() as {
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { operationId: string; "x-openai-isConsequential"?: boolean }>>;
    };
    const operations = Object.values(spec.paths).flatMap((methods) => Object.values(methods));
    expect(operations.map((op) => op.operationId).sort()).toEqual(
      ["getCompanyOverview", "getTask", "listOpenDecisions", "listPendingReview", "sendCommentToPulse"].sort(),
    );
    expect(spec.paths["/api/public/chatgpt/comments"].post["x-openai-isConsequential"]).toBe(true);
    expect(spec.servers[0].url).toMatch(/^https?:\/\//);
  });
});

describe("ChatGPT key authentication", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("rejects a request with no key, a wrong key, or a malformed header", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-auth.test" });
    await chatGptKeyFor(fixture);

    const app = await buildApp();
    const none = await app.inject({ method: "GET", url: "/api/public/chatgpt/overview" });
    const wrong = await app.inject({ method: "GET", url: "/api/public/chatgpt/overview", headers: bearer("not-the-key") });
    const malformed = await app.inject({
      method: "GET",
      url: "/api/public/chatgpt/overview",
      headers: { authorization: "Basic abc" },
    });
    await app.close();

    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(401);
  });

  it("does not accept a Circleback webhook token as a ChatGPT key", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-type-isolation.test" });
    const circleback = await generateIntegrationToken(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      type: "circleback",
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/public/chatgpt/overview",
      headers: bearer(circleback.rawToken),
    });
    await app.close();

    expect(response.statusCode).toBe(401);
  });

  it("stops working immediately once the key is turned off, and a rotated key replaces the old one", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-revoke.test" });
    const firstKey = await chatGptKeyFor(fixture);
    const secondKey = await chatGptKeyFor(fixture); // rotation

    const app = await buildApp();
    const oldKey = await app.inject({ method: "GET", url: "/api/public/chatgpt/overview", headers: bearer(firstKey) });
    const newKey = await app.inject({ method: "GET", url: "/api/public/chatgpt/overview", headers: bearer(secondKey) });

    await revokeIntegrationToken(db, { organizationId: fixture.org.id, actorId: fixture.user.id, type: "chatgpt" });
    const afterRevoke = await app.inject({ method: "GET", url: "/api/public/chatgpt/overview", headers: bearer(secondKey) });
    await app.close();

    expect(oldKey.statusCode).toBe(401);
    expect(newKey.statusCode).toBe(200);
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("records when the key was last used", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-last-used.test" });
    const key = await chatGptKeyFor(fixture);

    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/public/chatgpt/overview", headers: bearer(key) });
    await app.close();

    const [row] = await db
      .select()
      .from(webhookIntegrations)
      .where(and(eq(webhookIntegrations.organizationId, fixture.org.id), eq(webhookIntegrations.type, "chatgpt")));
    expect(row.lastReceivedAt).not.toBeNull();
  });
});

describe("ChatGPT read endpoints", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("overview shows every visibility level, open decisions and the pending-review count -- for its own org only", async () => {
    const orgA = await createFixtureOrg(db, { domain: "gpt-overview-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "gpt-overview-b.test" });
    await db.insert(tasks).values([
      { organizationId: orgA.org.id, projectId: orgA.project.id, title: "Team task", status: "active" },
      { organizationId: orgA.org.id, projectId: orgA.project.id, title: "Restricted task", status: "active", visibility: "restricted" },
      { organizationId: orgB.org.id, projectId: orgB.project.id, title: "Other org's task", status: "active" },
    ]);
    await db.insert(decisions).values([
      { organizationId: orgA.org.id, title: "Open call", decider: "CEO", status: "open" },
      { organizationId: orgA.org.id, title: "Already decided", decider: "CEO", status: "decided" },
    ]);
    await db.insert(suggestions).values({
      organizationId: orgA.org.id,
      sourceId: orgA.source.id,
      targetType: "objective",
      targetId: orgA.objective.id,
      changeType: "context",
      proposedDiff: { description: "x" },
      reasoning: "x",
      confidence: 0.5,
    });
    const key = await chatGptKeyFor(orgA);

    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/public/chatgpt/overview", headers: bearer(key) });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      objectives: Array<{ initiatives: Array<{ projects: Array<{ tasks: Array<{ title: string }> }> }> }>;
      openDecisions: Array<{ title: string }>;
      pendingReviewCount: number;
    };
    const taskTitles = body.objectives
      .flatMap((o) => o.initiatives)
      .flatMap((i) => i.projects)
      .flatMap((p) => p.tasks)
      .map((t) => t.title)
      .sort();
    expect(taskTitles).toEqual(["Restricted task", "Team task"]);
    expect(body.openDecisions.map((d) => d.title)).toEqual(["Open call"]);
    expect(body.pendingReviewCount).toBe(1);
  });

  it("task lookup returns detail and relationships, and 404s for another org's task or a bad id", async () => {
    const orgA = await createFixtureOrg(db, { domain: "gpt-task-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "gpt-task-b.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: orgA.org.id, projectId: orgA.project.id, title: "Calibrate rig", status: "active" })
      .returning();
    const [otherOrgTask] = await db
      .insert(tasks)
      .values({ organizationId: orgB.org.id, projectId: orgB.project.id, title: "Not yours", status: "active" })
      .returning();
    const key = await chatGptKeyFor(orgA);

    const app = await buildApp();
    const own = await app.inject({ method: "GET", url: `/api/public/chatgpt/tasks/${task.id}`, headers: bearer(key) });
    const foreign = await app.inject({
      method: "GET",
      url: `/api/public/chatgpt/tasks/${otherOrgTask.id}`,
      headers: bearer(key),
    });
    const badId = await app.inject({ method: "GET", url: "/api/public/chatgpt/tasks/not-a-uuid", headers: bearer(key) });
    await app.close();

    expect(own.statusCode).toBe(200);
    const body = own.json() as { task: { title: string }; project: { title: string }; relationships: unknown[] };
    expect(body.task.title).toBe("Calibrate rig");
    expect(body.project.title).toBe("Test project");
    expect(body.relationships).toEqual([]);
    expect(foreign.statusCode).toBe(404);
    expect(badId.statusCode).toBe(404);
  });

  it("review lists pending suggestions with a readable name for what each is about", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-review.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Order sensor harness", status: "active" })
      .returning();
    await db.insert(suggestions).values([
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: task.id,
        changeType: "operational_update",
        proposedDiff: { status: "blocked" },
        reasoning: "Vendor silent.",
        confidence: 0.7,
      },
      {
        organizationId: fixture.org.id,
        sourceId: fixture.source.id,
        targetType: "task",
        targetId: null,
        changeType: "new_task",
        proposedDiff: { projectId: fixture.project.id, title: "Call the vendor" },
        reasoning: "Follow-up.",
        confidence: 0.6,
      },
    ]);
    const key = await chatGptKeyFor(fixture);

    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/public/chatgpt/review", headers: bearer(key) });
    await app.close();

    const body = response.json() as { suggestions: Array<{ about: string; sourceType: string }> };
    expect(body.suggestions.map((s) => s.about).sort()).toEqual(["New task: Call the vendor", "Order sensor harness"]);
  });

  it("decisions lists only this org's open decisions", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-decisions.test" });
    await db.insert(decisions).values([
      { organizationId: fixture.org.id, title: "Which vendor?", decider: "Ops", status: "open", whyItMatters: "Lead time." },
      { organizationId: fixture.org.id, title: "Closed one", decider: "Ops", status: "decided" },
    ]);
    const key = await chatGptKeyFor(fixture);

    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/public/chatgpt/decisions", headers: bearer(key) });
    await app.close();

    const body = response.json() as { decisions: Array<{ title: string; whyItMatters: string }> };
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]).toMatchObject({ title: "Which vendor?", whyItMatters: "Lead time." });
  });
});

describe("POST /api/public/chatgpt/comments", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("turns a comment into a pending suggestion tagged as from ChatGPT, without changing the task itself", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-comment.test" });
    const [task] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Order sensor harness", status: "active" })
      .returning();
    const key = await chatGptKeyFor(fixture);

    const app = await buildApp();
    setClaudeClientForTesting(statusUpdateClient(task.id));
    const response = await app.inject({
      method: "POST",
      url: "/api/public/chatgpt/comments",
      headers: bearer(key),
      payload: { comment: "The sensor harness order looks stuck -- vendor hasn't replied in three weeks." },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { suggestionsCreated: number; skippedAsNoise: boolean; message: string };
    expect(body.suggestionsCreated).toBe(1);
    expect(body.skippedAsNoise).toBe(false);
    expect(body.message).toContain("Review");

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.targetId, task.id));
    expect(suggestion.status).toBe("pending");
    const [source] = await db.select().from(sources).where(eq(sources.id, suggestion.sourceId));
    expect(source.type).toBe("chatgpt");
    expect(source.rawBody).toContain("vendor hasn't replied");

    const [unchanged] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(unchanged.status).toBe("active");
  });

  it("rejects a blank comment", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-comment-blank.test" });
    const key = await chatGptKeyFor(fixture);

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/public/chatgpt/comments",
      headers: bearer(key),
      payload: { comment: "   " },
    });
    await app.close();

    expect(response.statusCode).toBe(400);
  });

  it("refuses more comments once the daily limit is reached, without calling Claude", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-comment-limit.test" });
    await db.insert(sources).values(
      Array.from({ length: CHATGPT_DAILY_COMMENT_LIMIT }, () => ({
        organizationId: fixture.org.id,
        type: "chatgpt" as const,
        externalId: randomUUID(),
        receivedAt: new Date(),
        rawBody: "earlier comment",
      })),
    );
    const key = await chatGptKeyFor(fixture);

    const app = await buildApp();
    setClaudeClientForTesting({
      createMessage: async () => {
        throw new Error("should not be called -- limit already reached");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/public/chatgpt/comments",
      headers: bearer(key),
      payload: { comment: "One more thing." },
    });
    setClaudeClientForTesting(undefined);
    await app.close();

    expect(response.statusCode).toBe(429);
  });
});

describe("ChatGPT key management on the Integrations routes", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

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

  it("generating a ChatGPT key returns the connection address instead of a webhook URL", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-generate.test" });
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/integrations/chatgpt/token",
      cookies: await cookieFor(fixture),
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    const body = response.json() as { token: string; webhookUrl: string | null; schemaUrl: string | null };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.webhookUrl).toBeNull();
    expect(body.schemaUrl).toMatch(/\/api\/public\/chatgpt\/openapi\.json$/);
  });

  it("turning off a key deletes it; turning off again reports there's nothing to turn off", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-turn-off.test" });
    await chatGptKeyFor(fixture);

    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    const first = await app.inject({ method: "DELETE", url: "/api/integrations/chatgpt/token", cookies });
    const second = await app.inject({ method: "DELETE", url: "/api/integrations/chatgpt/token", cookies });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
    const rows = await db.select().from(webhookIntegrations).where(eq(webhookIntegrations.organizationId, fixture.org.id));
    expect(rows).toHaveLength(0);
  });

  it("a non-admin can't generate or turn off keys", async () => {
    const fixture = await createFixtureOrg(db, { domain: "gpt-member.test", role: "member" });
    const app = await buildApp();
    const cookies = await cookieFor(fixture);
    const generate = await app.inject({ method: "POST", url: "/api/integrations/chatgpt/token", cookies });
    const revoke = await app.inject({ method: "DELETE", url: "/api/integrations/chatgpt/token", cookies });
    await app.close();

    expect(generate.statusCode).toBe(403);
    expect(revoke.statusCode).toBe(403);
  });
});
