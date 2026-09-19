import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { findDuplicateTasks, type DuplicateCandidateTask } from "../interpretation/duplicateDetection.js";
import type { ClaudeClient } from "../interpretation/claudeClient.js";

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

const taskA: DuplicateCandidateTask = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  title: "Call Biomerics about DV testing schedule",
  description: null,
  latestUpdate: null,
  nextAction: null,
  status: "active",
};
const taskB: DuplicateCandidateTask = {
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  title: "Follow up with Biomerics on DV testing timeline",
  description: "Same vendor call as before, just phrased differently.",
  latestUpdate: null,
  nextAction: null,
  status: "active",
};
const taskC: DuplicateCandidateTask = {
  id: "cccccccc-3333-4333-8333-333333333333",
  title: "Order replacement sensor harness",
  description: null,
  latestUpdate: null,
  nextAction: null,
  status: "active",
};

describe("findDuplicateTasks", () => {
  it("returns an empty array when fewer than two tasks are given (no client call needed)", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => {
        throw new Error("should not be called");
      },
    };
    expect(await findDuplicateTasks([], fakeClient)).toEqual([]);
    expect(await findDuplicateTasks([taskA], fakeClient)).toEqual([]);
  });

  it("returns the duplicate pair the model flags", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_duplicate_tasks", {
          duplicates: [
            { keepTaskId: taskB.id, supersedeTaskId: taskA.id, reasoning: "Same vendor call, tracked twice.", confidence: 0.9 },
          ],
        }),
    };

    const result = await findDuplicateTasks([taskA, taskB, taskC], fakeClient);
    expect(result).toEqual([
      { keepTaskId: taskB.id, supersedeTaskId: taskA.id, reasoning: "Same vendor call, tracked twice.", confidence: 0.9 },
    ]);
  });

  it("returns an empty array when the model finds nothing (the expected common case)", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => toolUseMessage("flag_duplicate_tasks", { duplicates: [] }),
    };
    const result = await findDuplicateTasks([taskA, taskC], fakeClient);
    expect(result).toEqual([]);
  });

  it("drops a self-referential pair (keepTaskId equal to supersedeTaskId)", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_duplicate_tasks", {
          duplicates: [{ keepTaskId: taskA.id, supersedeTaskId: taskA.id, reasoning: "n/a", confidence: 0.5 }],
        }),
    };
    expect(await findDuplicateTasks([taskA, taskB], fakeClient)).toEqual([]);
  });

  it("drops a pair referencing an id outside the given task list", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_duplicate_tasks", {
          duplicates: [
            { keepTaskId: taskA.id, supersedeTaskId: "99999999-9999-4999-8999-999999999999", reasoning: "n/a", confidence: 0.5 },
          ],
        }),
    };
    expect(await findDuplicateTasks([taskA, taskB], fakeClient)).toEqual([]);
  });

  it("keeps only the first pair when the same supersedeTaskId appears twice in one response", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_duplicate_tasks", {
          duplicates: [
            { keepTaskId: taskB.id, supersedeTaskId: taskA.id, reasoning: "First pair.", confidence: 0.9 },
            { keepTaskId: taskC.id, supersedeTaskId: taskA.id, reasoning: "Conflicting second pair.", confidence: 0.6 },
          ],
        }),
    };
    const result = await findDuplicateTasks([taskA, taskB, taskC], fakeClient);
    expect(result).toHaveLength(1);
    expect(result[0].reasoning).toBe("First pair.");
  });

  it("returns an empty array when the response has no tool_use block", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => ({ content: [{ type: "text", text: "no call" }] }) as unknown as Anthropic.Message,
    };
    expect(await findDuplicateTasks([taskA, taskB], fakeClient)).toEqual([]);
  });
});
