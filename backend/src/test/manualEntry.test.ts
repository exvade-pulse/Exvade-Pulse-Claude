import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { sources, suggestions } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
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

function forcedToolName(params: Anthropic.MessageCreateParamsNonStreaming): string | undefined {
  return params.tool_choice?.type === "tool" ? params.tool_choice.name : undefined;
}

function notNoiseThenSuggestionClient(): ClaudeClient {
  return {
    createMessage: async (params) => {
      if (forcedToolName(params) === "redact_text") {
        const body = params.messages[0]?.content as string;
        return toolUseMessage("redact_text", { redactedText: body });
      }
      if (params.model === NOISE_FILTER_MODEL) {
        return toolUseMessage("classify_source", { isNoise: false, reason: "Has a real action item." });
      }
      expect(params.model).toBe(INTERPRETATION_MODEL);
      return toolUseMessage("propose_suggestion", {
        changeType: "new_task",
        targetType: "task",
        targetId: null,
        proposedDiff: { title: "Order a replacement gasket", projectId: null },
        reasoning: "The note describes a new follow-up item.",
        confidence: 0.75,
      });
    },
  };
}

function noiseClient(): ClaudeClient {
  return {
    createMessage: async (params) => {
      if (forcedToolName(params) === "redact_text") {
        const body = params.messages[0]?.content as string;
        return toolUseMessage("redact_text", { redactedText: body });
      }
      return toolUseMessage("classify_source", { isNoise: true, reason: "No action items or updates." });
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

describe("POST /api/sources/manual", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/sources/manual", payload: { note: "Test" } });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("returns 400 when note is missing or blank", async () => {
    const fixture = await createFixtureOrg(db, { domain: "manual-blank.test" });
    const app = await buildApp();
    const cookies = { [SESSION_COOKIE_NAME]: await tokenFor(fixture) };

    const missing = await app.inject({ method: "POST", url: "/api/sources/manual", payload: {}, cookies });
    expect(missing.statusCode).toBe(400);

    const blank = await app.inject({ method: "POST", url: "/api/sources/manual", payload: { note: "   " }, cookies });
    expect(blank.statusCode).toBe(400);

    await app.close();
  });

  it("runs a submitted note through the real pipeline and creates a suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "manual-happy-path.test" });
    const app = await buildApp();
    setClaudeClientForTesting(notNoiseThenSuggestionClient());

    const response = await app.inject({
      method: "POST",
      url: "/api/sources/manual",
      payload: { note: "Vendor called back. Need to order a replacement gasket for rig #2 by Friday." },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { sourceId: string; suggestionIds: string[]; skippedAsNoise: boolean };
    expect(body.skippedAsNoise).toBe(false);
    expect(body.suggestionIds).toHaveLength(1);

    const [source] = await db.select().from(sources).where(eq(sources.id, body.sourceId));
    expect(source.type).toBe("manual");
    expect(source.organizationId).toBe(fixture.org.id);
    expect(source.rawBody).toContain("replacement gasket");

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, body.suggestionIds[0]));
    expect(suggestion.sourceId).toBe(body.sourceId);
    expect(suggestion.organizationId).toBe(fixture.org.id);

    setClaudeClientForTesting(undefined);
    await app.close();
  });

  it("stamps the submitting user's email as the note's from-identity in the noise-filter prompt", async () => {
    const fixture = await createFixtureOrg(db, { domain: "manual-from-identity.test" });
    const app = await buildApp();

    let noiseFilterPrompt: string | undefined;
    setClaudeClientForTesting({
      createMessage: async (params) => {
        if (forcedToolName(params) === "redact_text") {
          const bodyText = params.messages[0]?.content as string;
          return toolUseMessage("redact_text", { redactedText: bodyText });
        }
        noiseFilterPrompt = params.messages[0]?.content as string;
        return toolUseMessage("classify_source", { isNoise: true, reason: "No action items." });
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sources/manual",
      payload: { note: "Just checking in, nothing to report." },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });

    expect(response.statusCode).toBe(200);
    expect(noiseFilterPrompt).toContain(`From: ${fixture.user.email}`);

    setClaudeClientForTesting(undefined);
    await app.close();
  });

  it("classifies a low-signal note as noise and creates no suggestion, while still recording the source", async () => {
    const fixture = await createFixtureOrg(db, { domain: "manual-noise.test" });
    const app = await buildApp();
    setClaudeClientForTesting(noiseClient());

    const response = await app.inject({
      method: "POST",
      url: "/api/sources/manual",
      payload: { note: "Just checking in, nothing to report." },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { sourceId: string; suggestionIds: string[]; skippedAsNoise: boolean };
    expect(body.skippedAsNoise).toBe(true);
    expect(body.suggestionIds).toEqual([]);

    const [source] = await db.select().from(sources).where(eq(sources.id, body.sourceId));
    expect(source.type).toBe("manual");

    setClaudeClientForTesting(undefined);
    await app.close();
  });

  it("allows two submissions of the identical note text, each getting its own source row", async () => {
    const fixture = await createFixtureOrg(db, { domain: "manual-repeat.test" });
    const app = await buildApp();
    setClaudeClientForTesting(noiseClient());
    const cookies = { [SESSION_COOKIE_NAME]: await tokenFor(fixture) };

    const first = await app.inject({
      method: "POST",
      url: "/api/sources/manual",
      payload: { note: "Same note, submitted twice on purpose." },
      cookies,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/sources/manual",
      payload: { note: "Same note, submitted twice on purpose." },
      cookies,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstId = (first.json() as { sourceId: string }).sourceId;
    const secondId = (second.json() as { sourceId: string }).sourceId;
    expect(firstId).not.toBe(secondId);

    const rows = await db.select().from(sources).where(and(eq(sources.organizationId, fixture.org.id), eq(sources.type, "manual")));
    expect(rows).toHaveLength(2);

    setClaudeClientForTesting(undefined);
    await app.close();
  });
});
