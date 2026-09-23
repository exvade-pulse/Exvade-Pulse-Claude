import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";
import type { RelationType } from "../db/schema.js";

export const RELATIONSHIP_DETECTION_MODEL = "claude-sonnet-5";

// v1 scope: task<->task within one project, and task<->decision org-wide --
// see relationshipDetection's companion route for why (real, checkable
// detail lives on these two entity types; the others are a cheap future
// extension of the same mechanism).
export type RelationshipCandidateType = "task" | "decision";

export interface RelationshipCandidate {
  type: RelationshipCandidateType;
  id: string;
  title: string;
  // A task's description, or a decision's whyItMatters -- whichever field
  // each type actually has for "what is this about".
  detail: string | null;
  status: string;
}

export interface RelationshipProposal {
  fromType: RelationshipCandidateType;
  fromId: string;
  toType: RelationshipCandidateType;
  toId: string;
  relationType: RelationType;
  note: string | null;
  reasoning: string;
  confidence: number;
}

const relationTypeSchema = z.enum([
  "depends_on",
  "blocks",
  "informs",
  "affects",
  "part_of",
  "funded_by",
  "performed_by",
  "awaiting_response_from",
  "coupled_with",
  "constrains",
]);
const candidateTypeSchema = z.enum(["task", "decision"]);

const relationshipProposalSchema = z.object({
  fromType: candidateTypeSchema,
  fromId: z.string().uuid(),
  toType: candidateTypeSchema,
  toId: z.string().uuid(),
  relationType: relationTypeSchema,
  note: z.string().optional(),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const relationshipToolInputSchema = z.object({
  relationships: z.array(relationshipProposalSchema),
});

const FLAG_RELATIONSHIPS_TOOL: Anthropic.Tool = {
  name: "flag_relationships",
  description:
    "Report every genuine relationship you find among these tasks and decisions -- a real dependency, blocker, or connection between two specific items, not a vague topical similarity. Most runs find few or none -- call this with an empty relationships array unless you find something specific and checkable.",
  input_schema: {
    type: "object",
    properties: {
      relationships: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fromType: { type: "string", enum: ["task", "decision"], description: "The type of the first item." },
            fromId: { type: "string", description: "The id of the first item, copied verbatim from the list given." },
            toType: { type: "string", enum: ["task", "decision"], description: "The type of the second item." },
            toId: { type: "string", description: "The id of the second item, copied verbatim from the list given." },
            relationType: {
              type: "string",
              enum: relationTypeSchema.options,
              description:
                "How fromId relates to toId, from fromId's perspective -- e.g. depends_on means fromId depends on toId, blocks means fromId blocks toId.",
            },
            note: { type: "string", description: "Optional short note on why/how they're connected." },
            reasoning: {
              type: "string",
              description: "A short, specific explanation a human reviewer can scan in a few seconds: what in the content ties these two together.",
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Confidence that this is a genuine, specific relationship, from 0 to 1.",
            },
          },
          required: ["fromType", "fromId", "toType", "toId", "relationType", "reasoning", "confidence"],
        },
      },
    },
    required: ["relationships"],
  },
};

function buildPrompt(candidates: RelationshipCandidate[]): string {
  const lines = candidates
    .map((c) => {
      const parts = [`type=${c.type} id=${c.id} status=${c.status} title="${c.title}"`, c.detail ? `  detail: ${c.detail}` : null];
      return parts.filter((line): line is string => line !== null).join("\n");
    })
    .join("\n\n");

  return `These are tasks and open decisions currently tracked in one part of the company:

${lines}

Do any of these genuinely depend on, block, inform, or otherwise specifically connect to each other -- not just cover a similar general topic, but an actual, checkable relationship you can point to in their content (e.g. one task's deliverable is what another task is waiting on; a decision's outcome would directly affect a specific task)? For each real relationship, pick the most accurate relationType from the fixed list and call flag_relationships. It is normal and expected to find none -- only report a pair when you're specifically confident, not merely because they're in the same area of work.`;
}

// Checks one batch of tasks+decisions for genuine relationships in a single
// Claude call (not one call per pair) -- cheap enough to run across every
// project in an org without the cost scaling with candidate count squared.
// Defensively drops any pair referencing an id outside the given candidate
// pool (checked against its claimed type too, so a task id can't be
// accepted as a decision), a self-link, or a pair already in
// existingKeys (keyed exactly as the model would emit one, see
// relationshipSuggestions.ts's route for how that set is built) -- same
// "never trust a model-returned id blindly" posture as the rest of the
// interpretation pipeline.
export async function findRelationships(
  candidates: RelationshipCandidate[],
  existingKeys: Set<string>,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<RelationshipProposal[]> {
  if (candidates.length < 2) return [];

  const response = await claudeClient.createMessage({
    model: RELATIONSHIP_DETECTION_MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
    tools: [FLAG_RELATIONSHIPS_TOOL],
    messages: [{ role: "user", content: buildPrompt(candidates) }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) return [];

  const parsed = relationshipToolInputSchema.safeParse(toolUse.input);
  if (!parsed.success) return [];

  const knownByType = {
    task: new Set(candidates.filter((c) => c.type === "task").map((c) => c.id)),
    decision: new Set(candidates.filter((c) => c.type === "decision").map((c) => c.id)),
  };
  const seenThisRun = new Set<string>();
  const result: RelationshipProposal[] = [];

  for (const r of parsed.data.relationships) {
    if (r.fromType === r.toType && r.fromId === r.toId) continue;
    if (!knownByType[r.fromType].has(r.fromId) || !knownByType[r.toType].has(r.toId)) continue;
    const key = `${r.fromType}:${r.fromId}:${r.toType}:${r.toId}`;
    if (existingKeys.has(key) || seenThisRun.has(key)) continue;
    seenThisRun.add(key);
    result.push({
      fromType: r.fromType,
      fromId: r.fromId,
      toType: r.toType,
      toId: r.toId,
      relationType: r.relationType,
      note: r.note ?? null,
      reasoning: r.reasoning,
      confidence: r.confidence,
    });
  }

  return result;
}
