import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { suggestReclassification, type RetriageCandidateProject, type RetriageTaskInput } from "../interpretation/retriage.js";
import type { ClaudeClient } from "../interpretation/claudeClient.js";

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

const task: RetriageTaskInput = {
  id: "9f9c3b1a-1111-4111-8111-111111111111",
  title: "Order replacement sensor harness",
  description: "Rig #3 keeps dropping sensor readings mid-run.",
  latestUpdate: null,
  nextAction: null,
};

const candidates: RetriageCandidateProject[] = [
  {
    id: "9f9c3b1a-2222-4222-8222-222222222222",
    title: "Bench testing protocol",
    initiativeTitle: "Pre-clinical validation",
    objectiveTitle: "Advance device toward pivotal trial",
  },
  {
    id: "9f9c3b1a-3333-4333-8333-333333333333",
    title: "Data room preparation",
    initiativeTitle: "Investor diligence process",
    objectiveTitle: "Secure Series B financing",
  },
];

describe("suggestReclassification", () => {
  it("returns the proposed project when the model picks one of the given candidates", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("reclassify_task", {
          projectId: candidates[0].id,
          reasoning: "Sensor harness work matches the bench testing protocol project.",
          confidence: 0.8,
        }),
    };

    const result = await suggestReclassification(task, candidates, fakeClient);
    expect(result).toEqual({
      projectId: candidates[0].id,
      reasoning: "Sensor harness work matches the bench testing protocol project.",
      confidence: 0.8,
    });
  });

  it("returns null when the model declines to match (projectId null)", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("reclassify_task", {
          projectId: null,
          reasoning: "Nothing listed is a specific match.",
          confidence: 0,
        }),
    };

    const result = await suggestReclassification(task, candidates, fakeClient);
    expect(result).toBeNull();
  });

  it("returns null (defensively) when the model returns a projectId not among the given candidates", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("reclassify_task", {
          projectId: "9f9c3b1a-9999-4999-8999-999999999999",
          reasoning: "Hallucinated id.",
          confidence: 0.9,
        }),
    };

    const result = await suggestReclassification(task, candidates, fakeClient);
    expect(result).toBeNull();
  });

  it("returns null when the response has no tool_use block", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => ({ content: [{ type: "text", text: "no tool call" }] }) as unknown as Anthropic.Message,
    };

    const result = await suggestReclassification(task, candidates, fakeClient);
    expect(result).toBeNull();
  });

  it("returns null when the tool input fails schema validation", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => toolUseMessage("reclassify_task", { projectId: candidates[0].id }), // missing reasoning/confidence
    };

    const result = await suggestReclassification(task, candidates, fakeClient);
    expect(result).toBeNull();
  });

  it("includes the task and every candidate project in the prompt sent to Claude", async () => {
    let capturedPrompt = "";
    const fakeClient: ClaudeClient = {
      createMessage: async (params) => {
        capturedPrompt = params.messages[0]?.content as string;
        return toolUseMessage("reclassify_task", { projectId: null, reasoning: "n/a", confidence: 0 });
      },
    };

    await suggestReclassification(task, candidates, fakeClient);
    expect(capturedPrompt).toContain(task.title);
    expect(capturedPrompt).toContain(task.description!);
    for (const c of candidates) {
      expect(capturedPrompt).toContain(c.id);
      expect(capturedPrompt).toContain(c.title);
    }
  });
});
