import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { interpretSource, InterpretationError, INTERPRETATION_MODEL, type CompanyContext } from "../interpretation/interpret.js";
import type { ClaudeClient } from "../interpretation/claudeClient.js";

function fakeToolUseMessage(input: unknown): Anthropic.Message {
  return {
    content: [{ type: "tool_use", id: "tool_1", name: "propose_suggestion", input }],
  } as unknown as Anthropic.Message;
}

function fakeTextOnlyMessage(): Anthropic.Message {
  return { content: [{ type: "text", text: "I decided not to call a tool." }] } as unknown as Anthropic.Message;
}

function stubClient(response: Anthropic.Message, capture?: { params?: Anthropic.MessageCreateParamsNonStreaming }): ClaudeClient {
  return {
    createMessage: async (params) => {
      if (capture) capture.params = params;
      return response;
    },
  };
}

const source = {
  subject: "Rig #3 still dropping sensor readings",
  from: "lab-tech@exvadebio.com",
  body: "Happened again today, might be a firmware issue.",
  receivedAt: new Date("2026-01-01T00:00:00Z"),
};

function emptyContext(): CompanyContext {
  return { objectives: [], initiatives: [], projects: [], tasks: [] };
}

describe("interpretSource", () => {
  it("sends the context and forces the propose_suggestion tool on the Sonnet model", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: taskId, title: "Rig #3 sensor dropout", status: "active" }],
    };
    const capture: { params?: Anthropic.MessageCreateParamsNonStreaming } = {};
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "operational_update",
        targetType: "task",
        targetId: taskId,
        proposedDiff: { latestUpdate: "Happened again, suspected firmware issue." },
        reasoning: "Matches the existing rig #3 sensor dropout task; new occurrence reported.",
        confidence: 0.85,
      }),
      capture,
    );

    await interpretSource(source, context, client);

    expect(capture.params?.model).toBe(INTERPRETATION_MODEL);
    expect(capture.params?.tool_choice).toEqual({ type: "tool", name: "propose_suggestion" });
    const userContent = capture.params?.messages[0]?.content as string;
    expect(userContent).toContain(taskId);
    expect(userContent).toContain("Rig #3 sensor dropout");
    expect(userContent).toContain(source.subject);
  });

  it("maps a valid update response onto SuggestionDraft and keeps only whitelisted fields", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: taskId, title: "Rig #3 sensor dropout", status: "active" }],
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "operational_update",
        targetType: "task",
        targetId: taskId,
        proposedDiff: {
          latestUpdate: "Happened again, suspected firmware issue.",
          status: "needs_attention",
          organizationId: "should-be-dropped",
          reviewedBy: "also-should-be-dropped",
        },
        reasoning: "Matches the existing rig #3 sensor dropout task.",
        confidence: 0.85,
      }),
    );

    const draft = await interpretSource(source, context, client);

    expect(draft.targetType).toBe("task");
    expect(draft.targetId).toBe(taskId);
    expect(draft.proposedDiff).toEqual({
      latestUpdate: "Happened again, suspected firmware issue.",
      status: "needs_attention",
    });
    expect(draft.proposedDiff.organizationId).toBeUndefined();
    expect(draft.proposedDiff.reviewedBy).toBeUndefined();
  });

  it("accepts a new_task proposal with targetId null", async () => {
    const projectId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      projects: [{ id: projectId, title: "Bench testing protocol", status: "active" }],
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "new_task",
        targetType: "task",
        targetId: null,
        proposedDiff: { projectId, title: "Investigate rig #3 firmware", nextAction: "Firmware team to review" },
        reasoning: "No existing task covers this; nothing in context matches rig #3 firmware issues.",
        confidence: 0.6,
      }),
    );

    const draft = await interpretSource(source, context, client);

    expect(draft.targetId).toBeNull();
    expect(draft.proposedDiff.projectId).toBe(projectId);
  });

  it("throws when the model does not call the tool", async () => {
    const client = stubClient(fakeTextOnlyMessage());

    await expect(interpretSource(source, emptyContext(), client)).rejects.toBeInstanceOf(InterpretationError);
  });

  it("throws when the tool input fails schema validation", async () => {
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "not_a_real_change_type",
        targetType: "task",
        targetId: null,
        proposedDiff: {},
        reasoning: "x",
        confidence: 0.5,
      }),
    );

    await expect(interpretSource(source, emptyContext(), client)).rejects.toBeInstanceOf(InterpretationError);
  });

  it("throws when confidence is out of range", async () => {
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "new_task",
        targetType: "task",
        targetId: null,
        proposedDiff: { projectId: randomUUID(), title: "x" },
        reasoning: "x",
        confidence: 1.5,
      }),
    );

    await expect(interpretSource(source, emptyContext(), client)).rejects.toBeInstanceOf(InterpretationError);
  });

  it("throws when targetId references an entity not present in the given context (hallucinated id)", async () => {
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: randomUUID(), title: "Some other task", status: "active" }],
    };
    const hallucinatedId = randomUUID();
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "operational_update",
        targetType: "task",
        targetId: hallucinatedId,
        proposedDiff: { status: "blocked" },
        reasoning: "x",
        confidence: 0.7,
      }),
    );

    await expect(interpretSource(source, context, client)).rejects.toBeInstanceOf(InterpretationError);
  });

  it("throws when targetId belongs to the wrong targetType's pool", async () => {
    const sharedId = randomUUID();
    const context: CompanyContext = {
      objectives: [{ id: sharedId, title: "An objective", status: "active" }],
      initiatives: [],
      projects: [],
      tasks: [],
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "operational_update",
        targetType: "task",
        targetId: sharedId,
        proposedDiff: { status: "blocked" },
        reasoning: "x",
        confidence: 0.7,
      }),
    );

    await expect(interpretSource(source, context, client)).rejects.toBeInstanceOf(InterpretationError);
  });
});
