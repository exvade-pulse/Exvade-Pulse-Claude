import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  interpretSource,
  InterpretationError,
  INTERPRETATION_MODEL,
  MAX_SUGGESTIONS_PER_SOURCE,
  SYSTEM_PROMPT,
  type CompanyContext,
} from "../interpretation/interpret.js";
import type { ClaudeClient } from "../interpretation/claudeClient.js";

function fakeToolUseMessage(input: unknown): Anthropic.Message {
  return {
    content: [{ type: "tool_use", id: "tool_1", name: "propose_suggestion", input }],
  } as unknown as Anthropic.Message;
}

function fakeMultiToolUseMessage(inputs: unknown[]): Anthropic.Message {
  return {
    content: inputs.map((input, i) => ({
      type: "tool_use",
      id: `tool_${i + 1}`,
      name: "propose_suggestion",
      input,
    })),
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
  return { objectives: [], initiatives: [], projects: [], tasks: [], decisions: [] };
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
    // auto, not forced -- Sonnet 5 only runs extended thinking when
    // tool_choice is auto, verified empirically against the real API.
    expect(capture.params?.tool_choice).toEqual({ type: "auto" });
    expect(capture.params?.thinking).toEqual({ type: "adaptive" });
    expect(capture.params?.output_config).toEqual({ effort: "high" });
    const userContent = capture.params?.messages[0]?.content as string;
    expect(userContent).toContain(taskId);
    expect(userContent).toContain("Rig #3 sensor dropout");
    expect(userContent).toContain(source.subject);
  });

  it("caches the system prompt with an ephemeral breakpoint, unchanged from SYSTEM_PROMPT", async () => {
    const capture: { params?: Anthropic.MessageCreateParamsNonStreaming } = {};
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "new_task",
        targetType: "task",
        targetId: null,
        proposedDiff: { projectId: randomUUID(), title: "x" },
        reasoning: "x",
        confidence: 0.5,
      }),
      capture,
    );

    await interpretSource(source, emptyContext(), client);

    expect(capture.params?.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
  });

  // A smoke test, not a behavioral one -- there's no way to mechanically
  // verify the model actually reads this correctly without a real API call,
  // which this test suite deliberately avoids (see README). This just
  // guards against the guidance silently regressing out of the prompt.
  it("SYSTEM_PROMPT includes planned-vs-happened and negation/correction guidance", () => {
    expect(SYSTEM_PROMPT).toContain("Planned vs. happened");
    expect(SYSTEM_PROMPT).toContain("Negation and correction");
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
        // Grounds the proposed status -- see "requires evidenceQuotes..."
        // tests below for what happens when this is missing.
        evidenceQuotes: ["Happened again today"],
      }),
    );

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(1);
    const [draft] = drafts;
    expect(draft.targetType).toBe("task");
    expect(draft.targetId).toBe(taskId);
    expect(draft.proposedDiff).toEqual({
      latestUpdate: "Happened again, suspected firmware issue.",
      status: "needs_attention",
    });
    expect(draft.proposedDiff.organizationId).toBeUndefined();
    expect(draft.proposedDiff.reviewedBy).toBeUndefined();
  });

  it("strips status/latestUpdate/nextAction from a context-changeType draft, keeping only description/owner", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: taskId, title: "Rig #3 sensor dropout", status: "active" }],
    };
    // Custom body (not the shared `source`) so evidenceQuotes has real text
    // to ground the proposed owner against.
    const ownerSource = {
      ...source,
      body: "Vendor confirmed the root cause was a bad harness batch, not firmware. Sean Meehan is coordinating the replacement.",
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "context",
        targetType: "task",
        targetId: taskId,
        proposedDiff: {
          description: "Vendor confirmed the root cause was a bad harness batch, not firmware.",
          owner: "Sean Meehan",
          status: "resolved",
          latestUpdate: "This must not survive sanitization",
          nextAction: "Neither must this",
        },
        reasoning: "Background info on an already-tracked task, not a state change.",
        confidence: 0.7,
        evidenceQuotes: ["Sean Meehan is coordinating the replacement"],
      }),
    );

    const drafts = await interpretSource(ownerSource, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedDiff).toEqual({
      description: "Vendor confirmed the root cause was a bad harness batch, not firmware.",
      owner: "Sean Meehan",
    });
  });

  it("drops owner when evidenceQuotes is empty, even though nothing else in the diff is affected", async () => {
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
        proposedDiff: { owner: "Sean Meehan", latestUpdate: "Progress continues." },
        reasoning: "test",
        confidence: 0.8,
        // No evidenceQuotes at all -- owner must not survive.
      }),
    );

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedDiff).toEqual({ latestUpdate: "Progress continues." });
  });

  it("drops owner when the evidenceQuote is invented rather than an actual substring of the source", async () => {
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
        proposedDiff: { owner: "Sean Meehan" },
        reasoning: "test",
        confidence: 0.8,
        // Not actually present in `source.body` -- an invented quote must not
        // satisfy the grounding check.
        evidenceQuotes: ["Sean Meehan confirmed he owns this"],
      }),
    );

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedDiff.owner).toBeUndefined();
  });

  it("evidence matching is whitespace/case-insensitive", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: taskId, title: "Rig #3 sensor dropout", status: "active" }],
    };
    const messySource = { ...source, body: "Status:   BLOCKED\n\n  waiting on the vendor part." };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "operational_update",
        targetType: "task",
        targetId: taskId,
        proposedDiff: { status: "blocked" },
        reasoning: "test",
        confidence: 0.8,
        evidenceQuotes: ["status: blocked"],
      }),
    );

    const drafts = await interpretSource(messySource, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedDiff.status).toBe("blocked");
  });

  it("drops dueDate on an ungrounded decision update, leaving the rest of the diff intact", async () => {
    const decisionId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      decisions: [{ id: decisionId, title: "Approve vendor switch", status: "open", decider: "CEO", whyItMatters: null }],
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "deadline",
        targetType: "decision",
        targetId: decisionId,
        proposedDiff: { dueDate: "2026-12-01", relevantContext: "Vendor requested a firmer timeline." },
        reasoning: "test",
        confidence: 0.6,
        // No evidenceQuotes -- dueDate must be dropped, relevantContext (not
        // a protected field) must survive.
      }),
    );

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedDiff).toEqual({ relevantContext: "Vendor requested a firmer timeline." });
  });

  it("strips a narrative field that restates the source's own ingestion date as if the source had said it", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: taskId, title: "Rig #3 sensor dropout", status: "active" }],
    };
    const dated = {
      ...source,
      receivedAt: new Date("2026-09-14T12:00:00Z"),
      body: "Vendor confirmed pricing is firm for the replacement part.",
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "operational_update",
        targetType: "task",
        targetId: taskId,
        proposedDiff: {
          latestUpdate: "As of September 14, 2026, the vendor confirmed pricing is firm.",
          nextAction: "Order the part.",
        },
        reasoning: "test",
        confidence: 0.7,
      }),
    );

    const drafts = await interpretSource(dated, context, client);

    expect(drafts).toHaveLength(1);
    // latestUpdate is dropped entirely (not surgically edited); nextAction,
    // which doesn't mention the fabricated date, survives untouched.
    expect(drafts[0].proposedDiff).toEqual({ nextAction: "Order the part." });
  });

  it("keeps a narrative field's date when the source itself genuinely states that date", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: taskId, title: "Rig #3 sensor dropout", status: "active" }],
    };
    const dated = {
      ...source,
      receivedAt: new Date("2026-09-14T12:00:00Z"),
      body: "Meeting notes from September 14, 2026: vendor confirmed pricing is firm.",
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "operational_update",
        targetType: "task",
        targetId: taskId,
        proposedDiff: { latestUpdate: "As of September 14, 2026, the vendor confirmed pricing is firm." },
        reasoning: "test",
        confidence: 0.7,
      }),
    );

    const drafts = await interpretSource(dated, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedDiff.latestUpdate).toBe("As of September 14, 2026, the vendor confirmed pricing is firm.");
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

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].targetId).toBeNull();
    expect(drafts[0].proposedDiff.projectId).toBe(projectId);
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
      decisions: [],
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

  it("returns multiple suggestions when Claude makes several parallel tool_use calls across different targetTypes", async () => {
    const objectiveId = randomUUID();
    const projectId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      objectives: [{ id: objectiveId, title: "Advance regulatory strategy", status: "active" }],
      projects: [{ id: projectId, title: "Bench testing protocol", status: "active" }],
    };
    const client = stubClient(
      fakeMultiToolUseMessage([
        {
          changeType: "operational_update",
          targetType: "objective",
          targetId: objectiveId,
          proposedDiff: { description: "FDA pre-sub meeting scheduled for next month." },
          reasoning: "Regulatory update mentioned in the weekly digest.",
          confidence: 0.8,
        },
        {
          changeType: "new_task",
          targetType: "task",
          targetId: null,
          proposedDiff: { projectId, title: "Order replacement sensor harness" },
          reasoning: "Engineering section calls out a new parts order, unrelated to the regulatory update.",
          confidence: 0.65,
        },
        {
          changeType: "context",
          targetType: "project",
          targetId: projectId,
          proposedDiff: { description: "Grant reviewers requested additional bench data." },
          reasoning: "Grants section references this project's bench testing data.",
          confidence: 0.6,
        },
      ]),
    );

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(3);
    expect(drafts.map((d) => d.targetType)).toEqual(["objective", "task", "project"]);
  });

  it("drops one invalid item among several valid ones, keeping the valid ones", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: taskId, title: "Rig #3 sensor dropout", status: "active" }],
    };
    const client = stubClient(
      fakeMultiToolUseMessage([
        {
          changeType: "operational_update",
          targetType: "task",
          targetId: taskId,
          proposedDiff: { latestUpdate: "Still happening." },
          reasoning: "Matches the existing task.",
          confidence: 0.8,
        },
        {
          // Hallucinated targetId not present in context -- should be dropped.
          changeType: "operational_update",
          targetType: "task",
          targetId: randomUUID(),
          proposedDiff: { status: "blocked" },
          reasoning: "x",
          confidence: 0.5,
        },
      ]),
    );

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].targetId).toBe(taskId);
  });

  it("throws InterpretationError when every item in a multi-item response fails validation", async () => {
    const client = stubClient(
      fakeMultiToolUseMessage([
        {
          changeType: "operational_update",
          targetType: "task",
          targetId: randomUUID(),
          proposedDiff: { status: "blocked" },
          reasoning: "x",
          confidence: 0.5,
        },
        {
          changeType: "not_a_real_change_type",
          targetType: "task",
          targetId: null,
          proposedDiff: {},
          reasoning: "x",
          confidence: 0.5,
        },
      ]),
    );

    await expect(interpretSource(source, emptyContext(), client)).rejects.toBeInstanceOf(InterpretationError);
  });

  it("accepts a decision proposal with targetId null and sanitizes proposedDiff to only decision-whitelisted fields", async () => {
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "decision",
        targetType: "decision",
        targetId: null,
        proposedDiff: {
          title: "Should we extend the fractional CFO engagement past Q4?",
          decider: "Leadership",
          stakeholders: ["Board of Directors", "Finance"],
          whyItMatters: "Engagement expires end of quarter with no successor plan.",
          resolution: "should-be-dropped", // not in the decision whitelist
          status: "should-be-dropped", // not in the decision whitelist
        },
        reasoning: "Email asks leadership to weigh in on whether to extend the CFO engagement.",
        confidence: 0.7,
      }),
    );

    const drafts = await interpretSource(source, emptyContext(), client);

    expect(drafts).toHaveLength(1);
    const [draft] = drafts;
    expect(draft.targetType).toBe("decision");
    expect(draft.targetId).toBeNull();
    expect(draft.proposedDiff).toEqual({
      title: "Should we extend the fractional CFO engagement past Q4?",
      decider: "Leadership",
      stakeholders: ["Board of Directors", "Finance"],
      whyItMatters: "Engagement expires end of quarter with no successor plan.",
    });
    expect(draft.proposedDiff.resolution).toBeUndefined();
    expect(draft.proposedDiff.status).toBeUndefined();
  });

  it("accepts a decision-update proposal whose targetId matches an existing open decision in context", async () => {
    const decisionId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      decisions: [
        {
          id: decisionId,
          title: "What should the fractional CFO engagement's scope be going forward?",
          status: "open",
          decider: "Leadership",
          whyItMatters: "Engagement expires end of quarter with no successor plan.",
        },
      ],
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "decision",
        targetType: "decision",
        targetId: decisionId,
        proposedDiff: {
          relevantContext: "Follow-up email asks for a status check on this exact open question.",
          decider: "should-be-dropped-not-in-update", // not stripped by whitelist, but exercised separately in apply.ts tests
        },
        reasoning: "This is a follow-up on the already-open CFO scope decision, not a new one.",
        confidence: 0.75,
      }),
    );

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].targetType).toBe("decision");
    expect(drafts[0].targetId).toBe(decisionId);
  });

  it("rejects a decision proposal whose targetId does not match any decision in the given context (hallucinated id)", async () => {
    const context: CompanyContext = {
      ...emptyContext(),
      decisions: [
        { id: randomUUID(), title: "Some other open decision", status: "open", decider: "Leadership", whyItMatters: null },
      ],
    };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "decision",
        targetType: "decision",
        targetId: randomUUID(),
        proposedDiff: { title: "Some decision", decider: "Leadership" },
        reasoning: "x",
        confidence: 0.7,
      }),
    );

    await expect(interpretSource(source, context, client)).rejects.toBeInstanceOf(InterpretationError);
  });

  it("rejects a decision proposal with a non-null targetId when no decisions are in context at all", async () => {
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "decision",
        targetType: "decision",
        targetId: randomUUID(),
        proposedDiff: { title: "Some decision", decider: "Leadership" },
        reasoning: "x",
        confidence: 0.7,
      }),
    );

    await expect(interpretSource(source, emptyContext(), client)).rejects.toBeInstanceOf(InterpretationError);
  });

  it("accepts owner in proposedDiff for a hierarchy targetType and keeps it through sanitization", async () => {
    const taskId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      tasks: [{ id: taskId, title: "Rig #3 sensor dropout", status: "active" }],
    };
    const ownerSource = { ...source, body: "Sean is now handling the rig #3 wiring fix." };
    const client = stubClient(
      fakeToolUseMessage({
        changeType: "operational_update",
        targetType: "task",
        targetId: taskId,
        proposedDiff: { owner: "Sean Meehan" },
        reasoning: "Email says Sean is now handling the rig #3 wiring fix.",
        confidence: 0.8,
        evidenceQuotes: ["Sean is now handling the rig #3 wiring fix"],
      }),
    );

    const drafts = await interpretSource(ownerSource, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedDiff.owner).toBe("Sean Meehan");
  });

  it("validates fine when a hierarchy targetType's proposedDiff plausibly omits owner (no evidence in the source)", async () => {
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
        proposedDiff: { status: "needs_attention" },
        reasoning: "No named owner in this update, just a status change.",
        confidence: 0.7,
      }),
    );

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedDiff.owner).toBeUndefined();
  });

  it("caps accepted tool_use calls at MAX_SUGGESTIONS_PER_SOURCE, keeping only the first N", async () => {
    const projectId = randomUUID();
    const context: CompanyContext = {
      ...emptyContext(),
      projects: [{ id: projectId, title: "Bench testing protocol", status: "active" }],
    };
    const overCount = MAX_SUGGESTIONS_PER_SOURCE + 3;
    const inputs = Array.from({ length: overCount }, (_, i) => ({
      changeType: "new_task",
      targetType: "task",
      targetId: null,
      proposedDiff: { projectId, title: `Task ${i}` },
      reasoning: `Reasoning for task ${i}.`,
      confidence: 0.5,
    }));
    const client = stubClient(fakeMultiToolUseMessage(inputs));

    const drafts = await interpretSource(source, context, client);

    expect(drafts).toHaveLength(MAX_SUGGESTIONS_PER_SOURCE);
    expect(drafts.map((d) => (d.proposedDiff as { title: string }).title)).toEqual(
      Array.from({ length: MAX_SUGGESTIONS_PER_SOURCE }, (_, i) => `Task ${i}`),
    );
  });
});
