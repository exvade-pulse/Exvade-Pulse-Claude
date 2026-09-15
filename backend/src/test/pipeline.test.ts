import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { tasks, suggestions, sources } from "../db/schema.js";
import { runInterpretationPipeline } from "../interpretation/pipeline.js";
import { setClaudeClientForTesting, type ClaudeClient } from "../interpretation/claudeClient.js";
import { NOISE_FILTER_MODEL } from "../interpretation/noiseFilter.js";
import { INTERPRETATION_MODEL } from "../interpretation/interpret.js";

const { db, client } = testDb();

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

describe("runInterpretationPipeline (integration, mocked Claude client)", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterEach(() => {
    setClaudeClientForTesting(undefined);
  });

  afterAll(async () => {
    await client.end();
  });

  it("noise sources: keeps the source row, writes no suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "pipeline-noise.test" });

    const fakeClient: ClaudeClient = {
      createMessage: async (params) => {
        expect(params.model).toBe(NOISE_FILTER_MODEL);
        return toolUseMessage("classify_source", { isNoise: true, reason: "Out-of-office autoreply." });
      },
    };
    setClaudeClientForTesting(fakeClient);

    const result = await runInterpretationPipeline(db, fixture.org.id, {
      type: "gmail",
      externalId: "ext-noise-1",
      subject: "Out of office",
      from: "auto@vendor.com",
      body: "I am currently out of the office.",
      receivedAt: new Date(),
    });

    expect(result.skippedAsNoise).toBe(true);
    expect(result.suggestionId).toBeNull();

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, result.sourceId));
    expect(sourceRow).toBeDefined();

    const suggestionRows = await db.select().from(suggestions).where(eq(suggestions.sourceId, result.sourceId));
    expect(suggestionRows).toHaveLength(0);
  });

  it("real signal: matches an existing task and writes an update suggestion referencing it", async () => {
    const fixture = await createFixtureOrg(db, { domain: "pipeline-match.test" });

    const [existingTask] = await db
      .insert(tasks)
      .values({
        organizationId: fixture.org.id,
        projectId: fixture.project.id,
        title: "Rig #3 sensor dropout",
        status: "active",
      })
      .returning();

    const fakeClient: ClaudeClient = {
      createMessage: async (params) => {
        if (params.model === NOISE_FILTER_MODEL) {
          return toolUseMessage("classify_source", { isNoise: false, reason: "Operational hardware report." });
        }
        expect(params.model).toBe(INTERPRETATION_MODEL);
        const userContent = params.messages[0]?.content as string;
        expect(userContent).toContain(existingTask.id);
        return toolUseMessage("propose_suggestion", {
          changeType: "operational_update",
          targetType: "task",
          targetId: existingTask.id,
          proposedDiff: { status: "needs_attention", latestUpdate: "Happened again today." },
          reasoning: "Matches the existing rig #3 sensor dropout task.",
          confidence: 0.82,
        });
      },
    };
    setClaudeClientForTesting(fakeClient);

    const result = await runInterpretationPipeline(db, fixture.org.id, {
      type: "gmail",
      externalId: "ext-match-1",
      subject: "Rig #3 again",
      from: "lab-tech@exvadebio.com",
      body: "Sensor dropout happened again today.",
      receivedAt: new Date(),
    });

    expect(result.skippedAsNoise).toBe(false);
    expect(result.suggestionId).not.toBeNull();

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.suggestionId!));
    expect(suggestion.targetId).toBe(existingTask.id);
    expect(suggestion.targetType).toBe("task");
    expect(suggestion.proposedDiff).toEqual({ status: "needs_attention", latestUpdate: "Happened again today." });
  });

  it("keeps the source row but writes no suggestion when interpretation returns an untrustworthy response", async () => {
    const fixture = await createFixtureOrg(db, { domain: "pipeline-bad-response.test" });

    const fakeClient: ClaudeClient = {
      createMessage: async (params) => {
        if (params.model === NOISE_FILTER_MODEL) {
          return toolUseMessage("classify_source", { isNoise: false, reason: "Might be relevant." });
        }
        // Hallucinated targetId not present in context -- must not be trusted.
        return toolUseMessage("propose_suggestion", {
          changeType: "operational_update",
          targetType: "task",
          targetId: "11111111-1111-1111-1111-111111111111",
          proposedDiff: { status: "blocked" },
          reasoning: "x",
          confidence: 0.5,
        });
      },
    };
    setClaudeClientForTesting(fakeClient);

    const result = await runInterpretationPipeline(db, fixture.org.id, {
      type: "gmail",
      externalId: "ext-bad-1",
      subject: "Something",
      from: "someone@exvadebio.com",
      body: "Some update.",
      receivedAt: new Date(),
    });

    expect(result.skippedAsNoise).toBe(false);
    expect(result.suggestionId).toBeNull();

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, result.sourceId));
    expect(sourceRow).toBeDefined();

    const suggestionRows = await db.select().from(suggestions).where(eq(suggestions.sourceId, result.sourceId));
    expect(suggestionRows).toHaveLength(0);
  });
});
