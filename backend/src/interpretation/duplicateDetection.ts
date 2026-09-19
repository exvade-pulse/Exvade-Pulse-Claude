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

export interface DuplicatePair {
  keepTaskId: string;
  supersedeTaskId: string;
  reasoning: string;
  confidence: number;
}

const duplicatePairSchema = z.object({
  keepTaskId: z.string().uuid(),
  supersedeTaskId: z.string().uuid(),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const duplicateToolInputSchema = z.object({
  duplicates: z.array(duplicatePairSchema),
});

const FLAG_DUPLICATES_TOOL: Anthropic.Tool = {
  name: "flag_duplicate_tasks",
  description:
    "Report every pair of tasks in this project that track the exact same underlying work item twice. Most projects have none -- call this with an empty duplicates array unless you find a genuine, specific duplicate.",
  input_schema: {
    type: "object",
    properties: {
      duplicates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            keepTaskId: {
              type: "string",
              description: "The id of the task to keep -- prefer the more complete/detailed or more recently updated one.",
            },
            supersedeTaskId: {
              type: "string",
              description: "The id of the duplicate task to mark superseded. Must differ from keepTaskId.",
            },
            reasoning: {
              type: "string",
              description: "A short, specific explanation of why these two tasks are the same underlying work item, not just related.",
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Confidence that these two tasks are genuinely duplicates, from 0 to 1.",
            },
          },
          required: ["keepTaskId", "supersedeTaskId", "reasoning", "confidence"],
        },
      },
    },
    required: ["duplicates"],
  },
};

function buildPrompt(tasks: DuplicateCandidateTask[]): string {
  const taskLines = tasks
    .map((t) => {
      const parts = [
        `id=${t.id} status=${t.status} title="${t.title}"`,
        t.description ? `  description: ${t.description}` : null,
        t.latestUpdate ? `  latest update: ${t.latestUpdate}` : null,
        t.nextAction ? `  next action: ${t.nextAction}` : null,
      ].filter((line): line is string => line !== null);
      return parts.join("\n");
    })
    .join("\n\n");

  return `These are all the open tasks currently tracked under one project:

${taskLines}

Do any of these tasks describe the exact same underlying piece of work tracked twice -- not just related or similar-sounding work, but genuinely the same thing (e.g. two tasks both about the same specific vendor call, the same specific bug, the same specific deliverable)? For each real duplicate pair, decide which one to keep (prefer the more complete or more recently updated one) and call flag_duplicate_tasks. It is normal and expected to find none -- only report a pair when you're specifically confident they track the same thing, not merely the same general topic.`;
}

// Checks one project's task list for genuine duplicates in a single Claude
// call (not one call per task pair) -- cheap enough to run across every
// project in an org without the cost scaling with task count squared.
// Defensively drops any pair referencing an id outside the given task list,
// a self-referential pair, or a second pair naming a supersedeTaskId already
// used by an earlier pair in the same response (a task can only be marked
// superseded once per run) -- same "never trust a model-returned id blindly"
// posture as the rest of the interpretation pipeline.
export async function findDuplicateTasks(
  tasks: DuplicateCandidateTask[],
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<DuplicatePair[]> {
  if (tasks.length < 2) return [];

  const response = await claudeClient.createMessage({
    model: DUPLICATE_DETECTION_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
    tools: [FLAG_DUPLICATES_TOOL],
    messages: [{ role: "user", content: buildPrompt(tasks) }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) return [];

  const parsed = duplicateToolInputSchema.safeParse(toolUse.input);
  if (!parsed.success) return [];

  const knownIds = new Set(tasks.map((t) => t.id));
  const usedSupersedeIds = new Set<string>();
  const result: DuplicatePair[] = [];

  for (const pair of parsed.data.duplicates) {
    if (pair.keepTaskId === pair.supersedeTaskId) continue;
    if (!knownIds.has(pair.keepTaskId) || !knownIds.has(pair.supersedeTaskId)) continue;
    if (usedSupersedeIds.has(pair.supersedeTaskId)) continue;
    usedSupersedeIds.add(pair.supersedeTaskId);
    result.push(pair);
  }

  return result;
}
