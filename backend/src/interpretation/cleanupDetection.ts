import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";

export const CLEANUP_MODEL = "claude-sonnet-5";

export type CleanupAction =
  | "close_completed"
  | "close_abandoned"
  | "supersede"
  | "replace"
  | "update_next_action"
  | "confirm_active"
  | "needs_human";

// A record the review flagged: stale (no evidence in 90+ days) or with a
// next action older than its evidence warrants.
export interface CleanupCandidate {
  type: "task" | "decision";
  id: string;
  title: string;
  status: string;
  why: "stale" | "stale_next_action";
  nextAction: string | null;
  latestUpdate: string | null;
  lastEvidence: string;
}

// Everything else in the same workstream, for judging whether newer work
// has replaced a candidate, plus the recent updates that may show it.
export interface CleanupContext {
  scope: string;
  otherTasks: Array<{ id: string; title: string; status: string; nextAction: string | null; lastEvidence: string }>;
  recentUpdates: Array<{ date: string; record: string; text: string }>;
  openDecisions: Array<{ id: string; title: string }>;
}

export interface CleanupProposal {
  recordType: "task" | "decision";
  recordId: string;
  action: CleanupAction;
  supersededById: string | null;
  replacement: { title: string; nextAction: string | null; description: string | null } | null;
  newNextAction: string | null;
  closingNote: string | null;
  reasoning: string;
  confidence: number;
}

const proposalSchema = z.object({
  recordType: z.enum(["task", "decision"]),
  recordId: z.string().uuid(),
  action: z.enum(["close_completed", "close_abandoned", "supersede", "replace", "update_next_action", "confirm_active", "needs_human"]),
  supersededById: z.string().uuid().nullable().optional(),
  replacement: z
    .object({ title: z.string().min(1), nextAction: z.string().nullable().optional(), description: z.string().nullable().optional() })
    .nullable()
    .optional(),
  newNextAction: z.string().nullable().optional(),
  closingNote: z.string().nullable().optional(),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const TOOL: Anthropic.Tool = {
  name: "propose_cleanup",
  description: "For each flagged record, propose exactly one way to resolve it. Every proposal goes to a human for approval.",
  input_schema: {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            recordType: { type: "string", enum: ["task", "decision"] },
            recordId: { type: "string", description: "The flagged record's id, copied verbatim." },
            action: {
              type: "string",
              enum: ["close_completed", "close_abandoned", "supersede", "replace", "update_next_action", "confirm_active", "needs_human"],
              description:
                "close_completed: evidence shows it was done. close_abandoned: it was dropped or no longer applies. supersede: an existing task listed below now covers the same work. replace: the nature of the work changed and a new task should take over (give the replacement). update_next_action: the record is still valid but its next action is outdated (give the new one). confirm_active: still genuinely live as recorded. needs_human: the evidence doesn't settle it.",
            },
            supersededById: { type: ["string", "null"], description: "For supersede only: the id of the existing task that covers it." },
            replacement: {
              type: ["object", "null"],
              description: "For replace only: the new task.",
              properties: {
                title: { type: "string" },
                nextAction: { type: ["string", "null"] },
                description: { type: ["string", "null"] },
              },
            },
            newNextAction: { type: ["string", "null"], description: "For update_next_action only." },
            closingNote: { type: ["string", "null"], description: "For close_*: one line on what happened." },
            reasoning: { type: "string", description: "One or two sentences citing the specific evidence." },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["recordType", "recordId", "action", "reasoning", "confidence"],
        },
      },
    },
    required: ["proposals"],
  },
};

function buildPrompt(candidates: CleanupCandidate[], context: CleanupContext): string {
  const flagged = candidates
    .map((c) =>
      [
        `${c.type} id=${c.id} status=${c.status} last evidence=${c.lastEvidence.slice(0, 10)} flagged=${c.why === "stale" ? "no evidence in 90+ days" : "next action looks outdated"}`,
        `  title: ${c.title}`,
        c.nextAction ? `  next action: ${c.nextAction}` : null,
        c.latestUpdate ? `  latest update: ${c.latestUpdate}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const others = context.otherTasks.length
    ? context.otherTasks.map((t) => `- id=${t.id} [${t.status}, evidence ${t.lastEvidence.slice(0, 10)}] ${t.title}${t.nextAction ? ` — next: ${t.nextAction}` : ""}`).join("\n")
    : "(none)";
  const updates = context.recentUpdates.length
    ? context.recentUpdates.map((u) => `- ${u.date.slice(0, 10)} · ${u.record}: ${u.text}`).join("\n")
    : "(none)";
  const openDecisions = context.openDecisions.length ? context.openDecisions.map((d) => `- ${d.title}`).join("\n") : "(none)";

  return `These records ${context.scope} were flagged as possibly out of date:

${flagged}

Other current work in the same area (possible replacements):
${others}

Recent updates in this area, newest first:
${updates}

Open decisions:
${openDecisions}

For each flagged record, propose exactly one resolution. Ground every proposal in the evidence above: prefer "supersede" when an existing task listed above clearly now covers the same work; "replace" when newer evidence changed the nature of the work (e.g. a grant check-in became a decision about outsourcing vs buying equipment); "update_next_action" when the record is still valid but its next step is clearly outdated. Old but plausible work with no contrary evidence is "confirm_active" or "needs_human" -- never close something just because it is old.`;
}

// One Claude call per workstream's flagged records. Drops anything that
// names a record outside the batch, supersedes with an unknown or same
// record, lacks the detail its action needs, or proposes an action a
// decision can't take here (decisions: next step, confirm, or needs_human
// only -- closing a decision stays a person's call on the Decisions page).
export async function proposeCleanup(
  candidates: CleanupCandidate[],
  context: CleanupContext,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<CleanupProposal[]> {
  if (candidates.length === 0) return [];
  const response = await claudeClient.createMessage({
    model: CLEANUP_MODEL,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
    tools: [TOOL],
    messages: [{ role: "user", content: buildPrompt(candidates, context) }],
  });
  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) return [];
  const parsed = z.object({ proposals: z.array(proposalSchema) }).safeParse(toolUse.input);
  if (!parsed.success) return [];

  const candidateKeys = new Set(candidates.map((c) => `${c.type}:${c.id}`));
  const otherTaskIds = new Set(context.otherTasks.map((t) => t.id));
  const seen = new Set<string>();
  const result: CleanupProposal[] = [];
  for (const p of parsed.data.proposals) {
    const key = `${p.recordType}:${p.recordId}`;
    if (!candidateKeys.has(key) || seen.has(key)) continue;
    if (p.recordType === "decision" && !["update_next_action", "confirm_active", "needs_human"].includes(p.action)) continue;
    if (p.action === "supersede" && (!p.supersededById || p.supersededById === p.recordId || !otherTaskIds.has(p.supersededById))) continue;
    if (p.action === "replace" && !p.replacement?.title) continue;
    if (p.action === "update_next_action" && !p.newNextAction) continue;
    seen.add(key);
    result.push({
      recordType: p.recordType,
      recordId: p.recordId,
      action: p.action,
      supersededById: p.action === "supersede" ? p.supersededById ?? null : null,
      replacement:
        p.action === "replace" && p.replacement
          ? { title: p.replacement.title, nextAction: p.replacement.nextAction ?? null, description: p.replacement.description ?? null }
          : null,
      newNextAction: p.action === "update_next_action" ? p.newNextAction ?? null : null,
      closingNote: p.closingNote ?? null,
      reasoning: p.reasoning,
      confidence: p.confidence,
    });
  }
  return result;
}
