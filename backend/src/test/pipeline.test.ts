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
import { PATIENT_IDENTIFIER_PLACEHOLDER, REDACTION_FAILURE_PLACEHOLDER_BODY } from "../interpretation/redactPatientIdentifiers.js";

const { db, client } = testDb();

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

function multiToolUseMessage(name: string, inputs: unknown[]): Anthropic.Message {
  return {
    content: inputs.map((input, i) => ({ type: "tool_use", id: `t${i + 1}`, name, input })),
  } as unknown as Anthropic.Message;
}

// Redaction and interpretation are both forced tool-use calls on the same
// underlying model (REDACTION_MODEL === INTERPRETATION_MODEL, both
// "claude-sonnet-5"), so tests must dispatch on the forced tool name, not the
// model string, to tell the calls apart.
function forcedToolName(params: Anthropic.MessageCreateParamsNonStreaming): string | undefined {
  return params.tool_choice?.type === "tool" ? params.tool_choice.name : undefined;
}

// Every real client in these tests goes through the redaction pre-pass first;
// this stub is a no-op passthrough so tests unrelated to redaction itself can
// assert on the body/content they already know about.
function passthroughRedaction(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.Message | undefined {
  if (forcedToolName(params) !== "redact_text") return undefined;
  const body = params.messages[0]?.content as string;
  return toolUseMessage("redact_text", { redactedText: body });
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
        const passthrough = passthroughRedaction(params);
        if (passthrough) return passthrough;
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
    expect(result.suggestionIds).toEqual([]);

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
        const passthrough = passthroughRedaction(params);
        if (passthrough) return passthrough;
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
    expect(result.suggestionIds).toHaveLength(1);

    const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, result.suggestionIds[0]));
    expect(suggestion.targetId).toBe(existingTask.id);
    expect(suggestion.targetType).toBe("task");
    expect(suggestion.proposedDiff).toEqual({ status: "needs_attention", latestUpdate: "Happened again today." });
  });

  it("multi-topic source: writes one suggestions row per parallel propose_suggestion call", async () => {
    const fixture = await createFixtureOrg(db, { domain: "pipeline-multi.test" });

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
        const passthrough = passthroughRedaction(params);
        if (passthrough) return passthrough;
        if (params.model === NOISE_FILTER_MODEL) {
          return toolUseMessage("classify_source", { isNoise: false, reason: "Weekly update, several topics." });
        }
        expect(params.model).toBe(INTERPRETATION_MODEL);
        return multiToolUseMessage("propose_suggestion", [
          {
            changeType: "operational_update",
            targetType: "task",
            targetId: existingTask.id,
            proposedDiff: { latestUpdate: "Still dropping readings." },
            reasoning: "Engineering section matches the existing rig #3 task.",
            confidence: 0.8,
          },
          {
            changeType: "context",
            targetType: "objective",
            targetId: fixture.objective.id,
            proposedDiff: { description: "Grant reviewers requested more bench data." },
            reasoning: "Grants section references this objective.",
            confidence: 0.6,
          },
          {
            changeType: "new_task",
            targetType: "task",
            targetId: null,
            proposedDiff: { projectId: fixture.project.id, title: "Order replacement wiring harness" },
            reasoning: "Finance section approved a new parts order, unrelated to the other two topics.",
            confidence: 0.55,
          },
        ]);
      },
    };
    setClaudeClientForTesting(fakeClient);

    const result = await runInterpretationPipeline(db, fixture.org.id, {
      type: "gmail",
      externalId: "ext-multi-1",
      subject: "Weekly company update",
      from: "lead@exvadebio.com",
      body: "Engineering: rig #3 still dropping readings. Grants: reviewers want more bench data. Finance: approved a new wiring harness order.",
      receivedAt: new Date(),
    });

    expect(result.skippedAsNoise).toBe(false);
    expect(result.suggestionIds).toHaveLength(3);

    const suggestionRows = await db.select().from(suggestions).where(eq(suggestions.sourceId, result.sourceId));
    expect(suggestionRows).toHaveLength(3);
    expect(suggestionRows.map((s) => s.targetType).sort()).toEqual(["objective", "task", "task"]);
  });

  it("keeps the source row but writes no suggestion when interpretation returns an untrustworthy response", async () => {
    const fixture = await createFixtureOrg(db, { domain: "pipeline-bad-response.test" });

    const fakeClient: ClaudeClient = {
      createMessage: async (params) => {
        const passthrough = passthroughRedaction(params);
        if (passthrough) return passthrough;
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
    expect(result.suggestionIds).toEqual([]);

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, result.sourceId));
    expect(sourceRow).toBeDefined();

    const suggestionRows = await db.select().from(suggestions).where(eq(suggestions.sourceId, result.sourceId));
    expect(suggestionRows).toHaveLength(0);
  });

  it("persists the redacted body to sources.rawBody, not the raw patient-shaped input", async () => {
    const fixture = await createFixtureOrg(db, { domain: "pipeline-redact.test" });

    const rawBody =
      "Patient Jane Testperson, DOB 1/1/1990, is the 34-year-old glioblastoma patient from Duke who enrolled in March. Tejas will draft the interview question list.";
    const redactedBody = `Patient ${PATIENT_IDENTIFIER_PLACEHOLDER}, DOB ${PATIENT_IDENTIFIER_PLACEHOLDER}, is ${PATIENT_IDENTIFIER_PLACEHOLDER}. Tejas will draft the interview question list.`;

    const fakeClient: ClaudeClient = {
      createMessage: async (params) => {
        if (forcedToolName(params) === "redact_text") {
          return toolUseMessage("redact_text", { redactedText: redactedBody });
        }
        if (params.model === NOISE_FILTER_MODEL) {
          return toolUseMessage("classify_source", { isNoise: false, reason: "Real planning content." });
        }
        expect(params.model).toBe(INTERPRETATION_MODEL);
        const userContent = params.messages[0]?.content as string;
        // The interpretation pass must only ever see the redacted body, never the raw one.
        expect(userContent).not.toContain("Jane Testperson");
        expect(userContent).toContain(PATIENT_IDENTIFIER_PLACEHOLDER);
        return toolUseMessage("propose_suggestion", {
          changeType: "new_task",
          targetType: "task",
          targetId: null,
          proposedDiff: { projectId: fixture.project.id, title: "Draft interview question list" },
          reasoning: "New planning task mentioned in the source.",
          confidence: 0.6,
        });
      },
    };
    setClaudeClientForTesting(fakeClient);

    const result = await runInterpretationPipeline(db, fixture.org.id, {
      type: "circleback",
      externalId: "ext-redact-1",
      subject: "Interview discussion",
      from: "Circleback",
      body: rawBody,
      receivedAt: new Date(),
    });

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, result.sourceId));
    expect(sourceRow.rawBody).toBe(redactedBody);
    expect(sourceRow.rawBody).not.toContain("Jane Testperson");
  });

  it("fails closed: on a redaction failure, keeps a source row with the safe placeholder body and creates no suggestion", async () => {
    const fixture = await createFixtureOrg(db, { domain: "pipeline-redact-fail.test" });

    const fakeClient: ClaudeClient = {
      createMessage: async (params) => {
        if (forcedToolName(params) === "redact_text") {
          throw new Error("Simulated Claude API error during redaction.");
        }
        throw new Error(`Unexpected call (forced tool ${forcedToolName(params)}); pipeline should have stopped after redaction failed.`);
      },
    };
    setClaudeClientForTesting(fakeClient);

    const result = await runInterpretationPipeline(db, fixture.org.id, {
      type: "circleback",
      externalId: "ext-redact-fail-1",
      subject: "Interview discussion",
      from: "Circleback",
      body: "Patient Jane Testperson, DOB 1/1/1990, ...",
      receivedAt: new Date(),
    });

    expect(result.skippedAsNoise).toBe(false);
    expect(result.suggestionIds).toEqual([]);

    const [sourceRow] = await db.select().from(sources).where(eq(sources.id, result.sourceId));
    expect(sourceRow).toBeDefined();
    expect(sourceRow.rawBody).toBe(REDACTION_FAILURE_PLACEHOLDER_BODY);
    expect(sourceRow.rawBody).not.toContain("Jane Testperson");

    const suggestionRows = await db.select().from(suggestions).where(eq(suggestions.sourceId, result.sourceId));
    expect(suggestionRows).toHaveLength(0);
  });
});
