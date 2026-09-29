import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";

export const DUPLICATE_DETECTION_MODEL = "claude-sonnet-5";

export interface DuplicateCandidateTask {
  id: string;
  title: string;
  description: string | null;
  latestUpdate: string | null;
  nextAction: string | null;
  status: string;
}

export interface DuplicateCandidateDecision {
  id: string;
  title: string;
  whyItMatters: string | null;
  relevantContext: string | null;
  decider: string;
  dueDate: Date | null;
  status: string;
}

export interface DuplicatePair {
  keepTaskId: string;
  supersedeTaskId: string;
  reasoning: string;
  confidence: number;
}

export interface DuplicateDecisionPair {
  keepDecisionId: string;
  supersedeDecisionId: string;
  reasoning: string;
  confidence: number;
}

interface GenericPair {
  keepId: string;
  supersedeId: string;
  reasoning: string;
  confidence: number;
}

interface DuplicateKind<T> {
  toolName: string;
  // Plural noun used in the prompt and tool description ("tasks", "decisions").
  noun: string;
  keepKey: string;
  supersedeKey: string;
  keepHint: string;
  scope: string;
  examples: string;
  format: (item: T) => string[];
}

function buildTool<T>(kind: DuplicateKind<T>): Anthropic.Tool {
  return {
    name: kind.toolName,
    description: `Report every pair of ${kind.noun} that track the exact same underlying item twice. Most lists have none -- call this with an empty duplicates array unless you find a genuine, specific duplicate.`,
    input_schema: {
      type: "object",
      properties: {
        duplicates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              [kind.keepKey]: { type: "string", description: `The id to keep -- ${kind.keepHint}` },
              [kind.supersedeKey]: {
                type: "string",
                description: `The id of the duplicate to mark superseded. Must differ from ${kind.keepKey}.`,
              },
              reasoning: {
                type: "string",
                description: "A short, specific explanation of why these two are the same underlying item, not just related.",
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "Confidence that these two are genuinely duplicates, from 0 to 1.",
              },
            },
            required: [kind.keepKey, kind.supersedeKey, "reasoning", "confidence"],
          },
        },
      },
      required: ["duplicates"],
    },
  };
}

// One Claude call per list (not per pair), so cost scales with the number of
// lists checked rather than items squared. Defensively drops any pair naming
// an id outside the given list, a self-pair, or a second pair reusing an
// already-superseded id (each item can only be marked superseded once per
// run) -- the same "never trust a model-returned id blindly" posture as the
// rest of the interpretation pipeline.
async function findDuplicates<T extends { id: string }>(
  items: T[],
  kind: DuplicateKind<T>,
  claudeClient: ClaudeClient,
): Promise<GenericPair[]> {
  if (items.length < 2) return [];

  const lines = items.map((item) => kind.format(item).join("\n")).join("\n\n");
  const prompt = `These are all the open ${kind.noun} currently tracked ${kind.scope}:

${lines}

Do any of these describe the exact same underlying item tracked twice -- not just related or similar-sounding, but genuinely the same thing, even if worded differently (${kind.examples})? For each real duplicate pair, decide which one to keep (${kind.keepHint}) and call ${kind.toolName}. It is normal and expected to find none -- only report a pair when you're specifically confident they track the same thing, not merely the same general topic.`;

  const response = await claudeClient.createMessage({
    model: DUPLICATE_DETECTION_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
    tools: [buildTool(kind)],
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) return [];

  const pairSchema = z.object({
    [kind.keepKey]: z.string().uuid(),
    [kind.supersedeKey]: z.string().uuid(),
    reasoning: z.string().min(1),
    confidence: z.number().min(0).max(1),
  });
  const parsed = z.object({ duplicates: z.array(pairSchema) }).safeParse(toolUse.input);
  if (!parsed.success) return [];

  const knownIds = new Set(items.map((item) => item.id));
  const usedSupersedeIds = new Set<string>();
  const result: GenericPair[] = [];
  for (const raw of parsed.data.duplicates) {
    const pair = raw as Record<string, unknown>;
    const keepId = String(pair[kind.keepKey]);
    const supersedeId = String(pair[kind.supersedeKey]);
    if (keepId === supersedeId) continue;
    if (!knownIds.has(keepId) || !knownIds.has(supersedeId)) continue;
    if (usedSupersedeIds.has(supersedeId)) continue;
    usedSupersedeIds.add(supersedeId);
    result.push({ keepId, supersedeId, reasoning: String(pair.reasoning), confidence: Number(pair.confidence) });
  }
  return result;
}

const TASK_KIND: DuplicateKind<DuplicateCandidateTask> = {
  toolName: "flag_duplicate_tasks",
  noun: "tasks",
  keepKey: "keepTaskId",
  supersedeKey: "supersedeTaskId",
  keepHint: "prefer the more complete/detailed or more recently updated one",
  scope: "under one project",
  examples: "e.g. two tasks both about the same specific vendor call, the same specific bug, the same specific deliverable",
  format: (t) =>
    [
      `id=${t.id} status=${t.status} title="${t.title}"`,
      t.description ? `  description: ${t.description}` : null,
      t.latestUpdate ? `  latest update: ${t.latestUpdate}` : null,
      t.nextAction ? `  next action: ${t.nextAction}` : null,
    ].filter((line): line is string => line !== null),
};

const DECISION_KIND: DuplicateKind<DuplicateCandidateDecision> = {
  toolName: "flag_duplicate_decisions",
  noun: "decisions",
  keepKey: "keepDecisionId",
  supersedeKey: "supersedeDecisionId",
  keepHint: "prefer the one with the clearer, more complete framing and context",
  scope: "for the company",
  examples:
    'e.g. "Which path should be chosen for Fast Track Grant Aim 1..." and "What path should be chosen for Fast Track Grant Aim 1..." are the same open question',
  format: (d) =>
    [
      `id=${d.id} status=${d.status} decider="${d.decider}"${d.dueDate ? ` due=${d.dueDate.toISOString().slice(0, 10)}` : ""} title="${d.title}"`,
      d.whyItMatters ? `  why it matters: ${d.whyItMatters}` : null,
      d.relevantContext ? `  context: ${d.relevantContext}` : null,
    ].filter((line): line is string => line !== null),
};

export async function findDuplicateTasks(
  tasks: DuplicateCandidateTask[],
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<DuplicatePair[]> {
  const pairs = await findDuplicates(tasks, TASK_KIND, claudeClient);
  return pairs.map((p) => ({ keepTaskId: p.keepId, supersedeTaskId: p.supersedeId, reasoning: p.reasoning, confidence: p.confidence }));
}

export async function findDuplicateDecisions(
  decisions: DuplicateCandidateDecision[],
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<DuplicateDecisionPair[]> {
  const pairs = await findDuplicates(decisions, DECISION_KIND, claudeClient);
  return pairs.map((p) => ({
    keepDecisionId: p.keepId,
    supersedeDecisionId: p.supersedeId,
    reasoning: p.reasoning,
    confidence: p.confidence,
  }));
}

export interface DuplicateCandidateHierarchy {
  id: string;
  title: string;
  description: string | null;
  status: string;
  // Where it sits, e.g. "under initiative: Pre-clinical validation".
  parent: string | null;
  // What is filed under it, e.g. "7 tasks".
  contents: string;
}

export interface DuplicateHierarchyPair {
  keepId: string;
  supersedeId: string;
  reasoning: string;
  confidence: number;
}

const HIERARCHY_EXAMPLES: Record<"objective" | "initiative" | "project", string> = {
  objective: 'e.g. "Secure Series B financing" and "Raise Series B" are the same goal',
  initiative: 'e.g. "Pre-clinical validation" and "Preclinical validation studies" are the same body of work',
  project: 'e.g. "Bench testing protocol" and "Bench test protocol development" are the same project, even if filed under different initiatives',
};

// Same one-call-per-list check, for one level of the strategy hierarchy
// across the whole company (a duplicate project is often filed under a
// different initiative than its original).
export async function findDuplicateHierarchy(
  level: "objective" | "initiative" | "project",
  items: DuplicateCandidateHierarchy[],
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<DuplicateHierarchyPair[]> {
  return findDuplicates(
    items,
    {
      toolName: `flag_duplicate_${level}s`,
      noun: `${level}s`,
      keepKey: "keepId",
      supersedeKey: "supersedeId",
      keepHint: "prefer the one with more work filed under it and the clearer title",
      scope: "for the company",
      examples: HIERARCHY_EXAMPLES[level],
      format: (item) =>
        [
          `id=${item.id} status=${item.status} title="${item.title}"${item.parent ? ` (${item.parent})` : ""} — ${item.contents}`,
          item.description ? `  description: ${item.description}` : null,
        ].filter((line): line is string => line !== null),
    },
    claudeClient,
  );
}
