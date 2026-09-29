import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";
import { taskStatusEnum } from "../db/schema.js";

export const CONTRADICTION_DETECTION_MODEL = "claude-sonnet-5";

export type CheckedRecordType = "task" | "decision";

// Fields a contradiction may propose correcting -- the free-text/state
// fields a person reads as "what we currently believe", matching what the
// normal review flow may set on each type (see apply.ts's ALLOWED_FIELDS).
export const CORRECTABLE_FIELDS: Record<CheckedRecordType, string[]> = {
  task: ["title", "description", "status", "latestUpdate", "nextAction", "owner"],
  decision: ["title", "whyItMatters", "relevantContext", "suggestedNextStep"],
};

export interface CheckedStatement {
  field: string;
  value: string;
  // When this statement was last confirmed by a source, if known.
  asOf: string | null;
}

export interface CheckedRecord {
  type: CheckedRecordType;
  id: string;
  title: string;
  statements: CheckedStatement[];
  // Recent approved updates to this record, newest first -- newer evidence
  // that may contradict an older statement still sitting in a field.
  history: Array<{ date: string; text: string }>;
}

export interface Contradiction {
  recordType: CheckedRecordType;
  recordId: string;
  field: string;
  olderStatement: string;
  olderDate: string | null;
  newerStatement: string;
  newerDate: string | null;
  correctedValue: string;
  reasoning: string;
  confidence: number;
}

const contradictionSchema = z.object({
  recordType: z.enum(["task", "decision"]),
  recordId: z.string().uuid(),
  field: z.string().min(1),
  olderStatement: z.string().min(1),
  olderDate: z.string().nullable().optional(),
  newerStatement: z.string().min(1),
  newerDate: z.string().nullable().optional(),
  correctedValue: z.string().min(1),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const FLAG_CONTRADICTIONS_TOOL: Anthropic.Tool = {
  name: "flag_contradictions",
  description:
    "Report every place where newer information contradicts an older statement that is still recorded as current. Most records have none -- call this with an empty contradictions array unless you find a genuine factual conflict.",
  input_schema: {
    type: "object",
    properties: {
      contradictions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            recordType: { type: "string", enum: ["task", "decision"] },
            recordId: { type: "string", description: "The id of the record whose field should be corrected, copied verbatim." },
            field: { type: "string", description: "The field holding the outdated statement (one of the fields shown for that record)." },
            olderStatement: {
              type: "string",
              description: "The older statement, quoted or closely paraphrased. Just the statement -- put its date in olderDate, not here.",
            },
            olderDate: { type: ["string", "null"], description: "Date of the older statement if shown (YYYY-MM-DD), else null." },
            newerStatement: {
              type: "string",
              description:
                "The newer information that contradicts it. Just the statement -- put its date in newerDate, and name the other record in reasoning if it came from one.",
            },
            newerDate: { type: ["string", "null"], description: "Date of the newer information if shown (YYYY-MM-DD), else null." },
            correctedValue: {
              type: "string",
              description:
                "The full replacement text for that field, reflecting what is actually known now. If the truth is unresolved, say so explicitly (e.g. \"Unconfirmed; newer evidence suggests 21G, earlier notes said 18G\") -- never state the newer claim as settled fact if it isn't.",
            },
            reasoning: { type: "string", description: "One or two sentences: what conflicts with what, and why it matters." },
            confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence this is a genuine contradiction, 0 to 1." },
          },
          required: ["recordType", "recordId", "field", "olderStatement", "newerStatement", "correctedValue", "reasoning", "confidence"],
        },
      },
    },
    required: ["contradictions"],
  },
};

function buildPrompt(records: CheckedRecord[], scope: string): string {
  const blocks = records
    .map((r) => {
      const lines = [`${r.type} id=${r.id} title="${r.title}"`];
      for (const s of r.statements) lines.push(`  ${s.field}${s.asOf ? ` (as of ${s.asOf.slice(0, 10)})` : ""}: ${s.value}`);
      if (r.history.length > 0) {
        lines.push("  recent approved updates (newest first):");
        for (const h of r.history) lines.push(`    ${h.date.slice(0, 10)}: ${h.text}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return `These are the records currently tracked ${scope}, each with its fields (and when each was last confirmed, where known) and its recent approved updates:

${blocks}

Find places where newer information contradicts an older statement that is still recorded as current -- within one record (e.g. the description says one thing, a newer update says the opposite) or across records (one says enrollment is paused, a newer one says the site is still enrolling). Examples of real contradictions: a different needle gauge, a date that moved, a status that changed, an attribution that was later questioned.

Do not report: differences in wording, added detail that doesn't conflict, planned-vs-done progress, or two things that merely sound related. Be especially careful not to turn an old hypothesis into a fact, or a new unconfirmed claim into one: if the truth is unresolved, the corrected value should say so. It is normal to find none.`;
}

// One Claude call per batch of records. Defensively drops any finding that
// names a record outside the batch (or under the wrong type), a field that
// record type can't have corrected, an invalid task status, or a second
// finding for the same record+field -- the same "never trust a
// model-returned id blindly" posture as the rest of the pipeline.
export async function findContradictions(
  records: CheckedRecord[],
  scope: string,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<Contradiction[]> {
  if (records.length === 0) return [];

  const response = await claudeClient.createMessage({
    model: CONTRADICTION_DETECTION_MODEL,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
    tools: [FLAG_CONTRADICTIONS_TOOL],
    messages: [{ role: "user", content: buildPrompt(records, scope) }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) return [];
  const parsed = z.object({ contradictions: z.array(contradictionSchema) }).safeParse(toolUse.input);
  if (!parsed.success) return [];

  const known = new Map(records.map((r) => [`${r.type}:${r.id}`, r]));
  const validStatuses = new Set<string>(taskStatusEnum.enumValues);
  const seen = new Set<string>();
  const result: Contradiction[] = [];
  for (const c of parsed.data.contradictions) {
    const key = `${c.recordType}:${c.recordId}`;
    if (!known.has(key)) continue;
    if (!CORRECTABLE_FIELDS[c.recordType].includes(c.field)) continue;
    if (c.field === "status" && !validStatuses.has(c.correctedValue)) continue;
    if (seen.has(`${key}:${c.field}`)) continue;
    seen.add(`${key}:${c.field}`);
    result.push({
      recordType: c.recordType,
      recordId: c.recordId,
      field: c.field,
      olderStatement: c.olderStatement,
      olderDate: c.olderDate ?? null,
      newerStatement: c.newerStatement,
      newerDate: c.newerDate ?? null,
      correctedValue: c.correctedValue,
      reasoning: c.reasoning,
      confidence: c.confidence,
    });
  }
  return result;
}
