import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { findRelationships, type RelationshipCandidate } from "../interpretation/relationshipDetection.js";
import type { ClaudeClient } from "../interpretation/claudeClient.js";

function toolUseMessage(name: string, input: unknown): Anthropic.Message {
  return { content: [{ type: "tool_use", id: "t1", name, input }] } as unknown as Anthropic.Message;
}

const taskA: RelationshipCandidate = {
  type: "task",
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  title: "Calibrate sensor rig",
  detail: null,
  status: "active",
};
const taskB: RelationshipCandidate = {
  type: "task",
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  title: "Run DV testing on rig",
  detail: "Waiting on the rig to be calibrated first.",
  status: "active",
};
const decisionC: RelationshipCandidate = {
  type: "decision",
  id: "cccccccc-3333-4333-8333-333333333333",
  title: "Choose sensor vendor",
  detail: "Which vendor to buy the replacement sensor from.",
  status: "open",
};

const flagged = {
  fromType: "task" as const,
  fromId: taskB.id,
  toType: "task" as const,
  toId: taskA.id,
  relationType: "depends_on" as const,
  reasoning: "The DV testing task explicitly says it's waiting on calibration.",
  confidence: 0.9,
};

describe("findRelationships", () => {
  it("returns an empty array when fewer than two candidates are given (no client call needed)", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => {
        throw new Error("should not be called");
      },
    };
    expect(await findRelationships([], new Set(), fakeClient)).toEqual([]);
    expect(await findRelationships([taskA], new Set(), fakeClient)).toEqual([]);
  });

  it("returns the relationship the model flags", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => toolUseMessage("flag_relationships", { relationships: [flagged] }),
    };

    const result = await findRelationships([taskA, taskB], new Set(), fakeClient);
    expect(result).toEqual([{ ...flagged, note: null }]);
  });

  it("resolves a task<->decision relationship", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_relationships", {
          relationships: [
            {
              fromType: "decision",
              fromId: decisionC.id,
              toType: "task",
              toId: taskA.id,
              relationType: "affects",
              note: "Vendor choice affects the rig setup.",
              reasoning: "The decision names the same rig this task calibrates.",
              confidence: 0.75,
            },
          ],
        }),
    };
    const result = await findRelationships([taskA, decisionC], new Set(), fakeClient);
    expect(result).toEqual([
      {
        fromType: "decision",
        fromId: decisionC.id,
        toType: "task",
        toId: taskA.id,
        relationType: "affects",
        note: "Vendor choice affects the rig setup.",
        reasoning: "The decision names the same rig this task calibrates.",
        confidence: 0.75,
      },
    ]);
  });

  it("returns an empty array when the model finds nothing (the expected common case)", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => toolUseMessage("flag_relationships", { relationships: [] }),
    };
    expect(await findRelationships([taskA, taskB], new Set(), fakeClient)).toEqual([]);
  });

  it("drops a self-referential pair (same type and id on both ends)", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_relationships", {
          relationships: [{ ...flagged, fromType: "task", fromId: taskA.id, toType: "task", toId: taskA.id }],
        }),
    };
    expect(await findRelationships([taskA, taskB], new Set(), fakeClient)).toEqual([]);
  });

  it("drops a pair referencing an id outside the given candidate pool", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_relationships", {
          relationships: [{ ...flagged, toId: "99999999-9999-4999-8999-999999999999" }],
        }),
    };
    expect(await findRelationships([taskA, taskB], new Set(), fakeClient)).toEqual([]);
  });

  it("drops a pair whose id is known but under the wrong claimed type", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_relationships", {
          // taskA.id is a real candidate, but only as a task, not a decision
          relationships: [{ ...flagged, fromType: "decision", fromId: taskA.id }],
        }),
    };
    expect(await findRelationships([taskA, taskB], new Set(), fakeClient)).toEqual([]);
  });

  it("drops a pair already present in existingKeys", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => toolUseMessage("flag_relationships", { relationships: [flagged] }),
    };
    const existingKeys = new Set([`${flagged.fromType}:${flagged.fromId}:${flagged.toType}:${flagged.toId}`]);
    expect(await findRelationships([taskA, taskB], existingKeys, fakeClient)).toEqual([]);
  });

  it("keeps only the first pair when the same (from, to) pair repeats in one response", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () =>
        toolUseMessage("flag_relationships", {
          relationships: [
            { ...flagged, reasoning: "First pair." },
            { ...flagged, relationType: "blocks", reasoning: "Conflicting second pair." },
          ],
        }),
    };
    const result = await findRelationships([taskA, taskB], new Set(), fakeClient);
    expect(result).toHaveLength(1);
    expect(result[0].reasoning).toBe("First pair.");
  });

  it("returns an empty array when the response has no tool_use block", async () => {
    const fakeClient: ClaudeClient = {
      createMessage: async () => ({ content: [{ type: "text", text: "no call" }] }) as unknown as Anthropic.Message,
    };
    expect(await findRelationships([taskA, taskB], new Set(), fakeClient)).toEqual([]);
  });
});
