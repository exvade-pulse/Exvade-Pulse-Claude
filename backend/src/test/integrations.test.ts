import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { sources, suggestions, webhookIntegrations } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { generateIntegrationToken, hashToken } from "../integrations/manage.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { NOISE_FILTER_MODEL } from "../interpretation/noiseFilter.js";
import { INTERPRETATION_MODEL } from "../interpretation/interpret.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

function notNoiseThenSuggestionClient(): ClaudeClient {
  return {
    createMessage: async (params) => {
      if (params.model === NOISE_FILTER_MODEL) {
        return toolUseMessage("classify_source", { isNoise: false, reason: "Has real action items." });
      }
      expect(params.model).toBe(INTERPRETATION_MODEL);
      return toolUseMessage("propose_suggestion", {
        changeType: "new_task",
        targetType: "task",
        targetId: null,
        proposedDiff: { title: "Follow up on sensor calibration", projectId: null },
        reasoning: "Meeting notes mention a new follow-up item.",
        confidence: 0.7,
      });
    },
  };
}

async function tokenFor(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
  return signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: fixture.authorization.role,
  });
}

describe("POST /api/integrations/:type/token", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("stores only a hash of the token, never the raw value", async () => {
    const fixture = await createFixtureOrg(db, { domain: "token-hash.test" });

    const result = await generateIntegrationToken(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      type: "circleback",
    });

    const [row] = await db
      .select()
      .from(webhookIntegrations)
      .where(and(eq(webhookIntegrations.organizationId, fixture.org.id), eq(webhookIntegrations.type, "circleback")));

    expect(row).toBeDefined();
    expect(row.tokenHash).not.toBe(result.rawToken);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).toBe(hashToken(result.rawToken));
  });

  it("rotating replaces the token: the old raw token stops authenticating, the new one works", async () => {
    const fixture = await createFixtureOrg(db, { domain: "token-rotate.test" });

    const first = await generateIntegrationToken(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      type: "circleback",
    });

    const app = await buildApp();
    setClaudeClientForTesting(notNoiseThenSuggestionClient());

    const beforeRotate = await app.inject({
      method: "POST",
      url: `/api/public/webhooks/circleback?token=${first.rawToken}`,
      payload: { title: "Standup", notes: "All good.", id: "meeting-before-rotate" },
    });
    expect(beforeRotate.statusCode).toBe(200);

    const second = await generateIntegrationToken(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      type: "circleback",
    });
    expect(second.rotated).toBe(true);
    expect(second.rawToken).not.toBe(first.rawToken);

    const afterRotateOldToken = await app.inject({
      method: "POST",
      url: `/api/public/webhooks/circleback?token=${first.rawToken}`,
      payload: { title: "Standup 2", notes: "Still fine.", id: "meeting-after-rotate-old" },
    });
    expect(afterRotateOldToken.statusCode).toBe(401);

    const afterRotateNewToken = await app.inject({
      method: "POST",
      url: `/api/public/webhooks/circleback?token=${second.rawToken}`,
      payload: { title: "Standup 3", notes: "New token works.", id: "meeting-after-rotate-new" },
    });
    expect(afterRotateNewToken.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(webhookIntegrations)
      .where(and(eq(webhookIntegrations.organizationId, fixture.org.id), eq(webhookIntegrations.type, "circleback")));
    expect(rows).toHaveLength(1);

    setClaudeClientForTesting(undefined);
    await app.close();
  });

  it("requires admin (403 for a member) and is org-isolated", async () => {
    const memberFixture = await createFixtureOrg(db, { domain: "int-member.test", role: "member" });
    const orgA = await createFixtureOrg(db, { domain: "int-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "int-org-b.test" });

    await generateIntegrationToken(db, {
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      type: "circleback",
    });

    const app = await buildApp();

    const memberToken = await tokenFor(memberFixture);
    const asMember = await app.inject({
      method: "GET",
      url: "/api/integrations",
      cookies: { [SESSION_COOKIE_NAME]: memberToken },
    });
    expect(asMember.statusCode).toBe(403);

    const noSession = await app.inject({ method: "GET", url: "/api/integrations" });
    expect(noSession.statusCode).toBe(401);

    const tokenA = await tokenFor(orgA);
    const listA = await app.inject({
      method: "GET",
      url: "/api/integrations",
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
    });
    expect(listA.statusCode).toBe(200);
    const bodyA = listA.json() as { integrations: Array<{ type: string; configured: boolean }> };
    const circlebackA = bodyA.integrations.find((i) => i.type === "circleback");
    expect(circlebackA?.configured).toBe(false);

    const generateForA = await app.inject({
      method: "POST",
      url: "/api/integrations/circleback/token",
      cookies: { [SESSION_COOKIE_NAME]: tokenA },
    });
    expect(generateForA.statusCode).toBe(201);

    const [orgBRow] = await db
      .select()
      .from(webhookIntegrations)
      .where(and(eq(webhookIntegrations.organizationId, orgB.org.id), eq(webhookIntegrations.type, "circleback")));
    const [orgARow] = await db
      .select()
      .from(webhookIntegrations)
      .where(and(eq(webhookIntegrations.organizationId, orgA.org.id), eq(webhookIntegrations.type, "circleback")));
    expect(orgBRow.tokenHash).not.toBe(orgARow.tokenHash);

    await app.close();
  });
});

describe("POST /api/public/webhooks/circleback", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterEach(() => {
    setClaudeClientForTesting(undefined);
  });

  it("missing token: 401, no source row created", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/public/webhooks/circleback",
      payload: { title: "Standup", id: "m1" },
    });
    expect(response.statusCode).toBe(401);

    const rows = await db.select().from(sources);
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("invalid token: 401, no source row created", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/public/webhooks/circleback?token=not-a-real-token",
      payload: { title: "Standup", id: "m1" },
    });
    expect(response.statusCode).toBe(401);

    const rows = await db.select().from(sources);
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("valid token with notes/action-item-shaped payload creates a source and a suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "webhook-happy.test" });
    const { rawToken } = await generateIntegrationToken(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      type: "circleback",
    });

    setClaudeClientForTesting(notNoiseThenSuggestionClient());

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/public/webhooks/circleback?token=${rawToken}`,
      payload: {
        title: "Weekly eng sync",
        id: "meeting-happy-1",
        notes: "Discussed sensor calibration follow-up.",
        actionItems: ["Recalibrate rig #3 by Friday"],
        transcript: "excerpt of the discussion...",
        occurredAt: new Date().toISOString(),
      },
    });
    expect(response.statusCode).toBe(200);

    const sourceRows = await db
      .select()
      .from(sources)
      .where(and(eq(sources.organizationId, fixture.org.id), eq(sources.type, "circleback")));
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].type).toBe("circleback");
    expect(sourceRows[0].externalId).toBe("meeting-happy-1");
    expect(sourceRows[0].rawBody).toContain("Recalibrate rig #3 by Friday");

    const suggestionRows = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.sourceId, sourceRows[0].id));
    expect(suggestionRows).toHaveLength(1);

    const [integrationRow] = await db
      .select()
      .from(webhookIntegrations)
      .where(eq(webhookIntegrations.organizationId, fixture.org.id));
    expect(integrationRow.lastReceivedAt).not.toBeNull();

    await app.close();
  });

  it("duplicate delivery (same externalId, same org) returns 200 without creating a second source row", async () => {
    const fixture = await createFixtureOrg(db, { domain: "webhook-dup.test" });
    const { rawToken } = await generateIntegrationToken(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      type: "circleback",
    });

    setClaudeClientForTesting(notNoiseThenSuggestionClient());
    const app = await buildApp();

    const payload = { title: "Retro", id: "meeting-dup-1", notes: "Retro notes." };

    const first = await app.inject({
      method: "POST",
      url: `/api/public/webhooks/circleback?token=${rawToken}`,
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/public/webhooks/circleback?token=${rawToken}`,
      payload,
    });
    expect(second.statusCode).toBe(200);

    const sourceRows = await db
      .select()
      .from(sources)
      .where(and(eq(sources.organizationId, fixture.org.id), eq(sources.type, "circleback")));
    expect(sourceRows).toHaveLength(1);

    const suggestionRows = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.sourceId, sourceRows[0].id));
    expect(suggestionRows).toHaveLength(1);

    await app.close();
  });

  it("a payload missing expected fields still ingests, using a fallback externalId", async () => {
    const fixture = await createFixtureOrg(db, { domain: "webhook-sparse.test" });
    const { rawToken } = await generateIntegrationToken(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      type: "circleback",
    });

    setClaudeClientForTesting(notNoiseThenSuggestionClient());
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/public/webhooks/circleback?token=${rawToken}`,
      payload: { someUnexpectedShape: true, blob: "unstructured content with no recognizable fields" },
    });
    expect(response.statusCode).toBe(200);

    const sourceRows = await db
      .select()
      .from(sources)
      .where(and(eq(sources.organizationId, fixture.org.id), eq(sources.type, "circleback")));
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].externalId).toMatch(/^circleback-/);
    expect(sourceRows[0].rawBody).toContain("unstructured content with no recognizable fields");

    await app.close();
  });
});
