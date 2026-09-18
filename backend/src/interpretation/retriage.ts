import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";

export const RETRIAGE_MODEL = "claude-sonnet-5";

export interface RetriageTaskInput {
  id: string;
  title: string;
  description: string | null;
  latestUpdate: string | null;
  nextAction: string | null;
}

export interface RetriageCandidateProject {
  id: string;
  title: string;
  initiativeTitle: string;
  objectiveTitle: string;
}

export interface RetriageResult {
  projectId: string;
  reasoning: string;
  confidence: number;
}

const retriageToolInputSchema = z.object({
  projectId: z.string().uuid().nullable(),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const RECLASSIFY_TOOL: Anthropic.Tool = {
  name: "reclassify_task",
  description:
    "Decide whether this task, currently sitting in the 'Unsorted / Needs Triage' catch-all project, actually belongs under one of the real projects listed below now that they exist.",
  input_schema: {
    type: "object",
    properties: {
      projectId: {
        type: ["string", "null"],
        description:
          "The exact id of the real project this task belongs under, copied verbatim from the list given. null if none of the listed projects are a genuine match -- leaving a task in Unsorted is the right call, not a failure, whenever nothing listed actually fits.",
      },
      reasoning: {
        type: "string",
        description: "A short, specific explanation: what about the task matches (or fails to match) the chosen project.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confidence that this project is the right home for the task, from 0 to 1. Use 0 when projectId is null.",
      },
    },
    required: ["projectId", "reasoning", "confidence"],
  },
};

function buildPrompt(task: RetriageTaskInput, candidates: RetriageCandidateProject[]): string {
  const taskLines = [
    `Title: ${task.title}`,
    task.description ? `Description: ${task.description}` : null,
    task.latestUpdate ? `Latest update: ${task.latestUpdate}` : null,
    task.nextAction ? `Next action: ${task.nextAction}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const candidateLines = candidates
    .map((c) => `- id=${c.id} title="${c.title}" (under initiative "${c.initiativeTitle}", objective "${c.objectiveTitle}")`)
    .join("\n");

  return `This task is currently sitting in the "Unsorted / Needs Triage" catch-all project because no real project existed for it when it was first tracked:

${taskLines}

Real projects that exist now:
${candidateLines}

Does this task clearly belong under one of them? Only propose a match if it's a genuine, specific fit -- not just vaguely related to the same general area. Leaving it in Unsorted (projectId: null) is the correct, expected answer whenever nothing listed is a clear match.`;
}

// Asks Claude whether one Unsorted task now has a real home among the given
// candidate projects. Returns null whenever the model declines to propose a
// match (including a malformed/untrustworthy response) -- same "fail closed,
// leave it as-is" posture as the rest of the interpretation pipeline. Unlike
// interpretSource, targetId is never model-chosen here: the task is fixed by
// the caller, so the only real decision is "which project, if any."
export async function suggestReclassification(
  task: RetriageTaskInput,
  candidates: RetriageCandidateProject[],
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<RetriageResult | null> {
  const response = await claudeClient.createMessage({
    model: RETRIAGE_MODEL,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
    tools: [RECLASSIFY_TOOL],
    messages: [{ role: "user", content: buildPrompt(task, candidates) }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) return null;

  const parsed = retriageToolInputSchema.safeParse(toolUse.input);
  if (!parsed.success) return null;
  if (parsed.data.projectId === null) return null;

  // Defensive, same principle as interpret.ts's isKnownEntityId: never trust
  // that a model-returned id actually refers to one of the candidates we
  // handed it, even though it passed schema validation as a UUID.
  if (!candidates.some((c) => c.id === parsed.data.projectId)) return null;

  return { projectId: parsed.data.projectId, reasoning: parsed.data.reasoning, confidence: parsed.data.confidence };
}
