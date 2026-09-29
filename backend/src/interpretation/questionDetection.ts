import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";
import type { QuestionProposal } from "../questions/manage.js";
import { LIKELY_DUPLICATE_THRESHOLD, titleSimilarity, titleTokens } from "../suggestions/similarity.js";

export const QUESTION_MODEL = "claude-sonnet-5";
const MAX_NEW_DECISIONS = 5;

export interface QuestionContext {
  objectives: Array<{ id: string; title: string; description: string | null }>;
  decisions: Array<{ id: string; title: string; whyItMatters: string | null; decider: string; status: string }>;
  projects: Array<{ id: string; title: string; objective: string }>;
  tasks: Array<{ id: string; title: string; project: string; status: string; nextAction: string | null }>;
  // Questions that exist or are already proposed, so they aren't repeated.
  existingQuestions: Array<{ title: string; objective: string }>;
}

export interface ProposedQuestion extends QuestionProposal {
  reasoning: string;
  confidence: number;
}

const proposalSchema = z.object({
  objectiveId: z.string().uuid(),
  title: z.string().min(1),
  hypothesis: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  nextAction: z.string().nullable().optional(),
  keyDependency: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  decisionIds: z.array(z.string().uuid()).optional(),
  taskIds: z.array(z.string().uuid()).optional(),
  projectIds: z.array(z.string().uuid()).optional(),
  convertDecisionId: z.string().uuid().nullable().optional(),
  newDecisions: z.array(z.object({ title: z.string().min(1), decider: z.string().nullable().optional() })).optional(),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const TOOL: Anthropic.Tool = {
  name: "propose_strategic_questions",
  description: "Propose the strategic questions this company is working to answer, each linked to the decisions and work that feed it. Every proposal goes to a human for approval.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            objectiveId: { type: "string", description: "The objective this question sits under, id copied verbatim." },
            title: { type: "string", description: "The question itself, phrased as a question, e.g. \"Can we sample reliably enough for diagnostic use?\"" },
            hypothesis: { type: ["string", "null"], description: "The current best answer the evidence points to, in one or two sentences, or null if the evidence doesn't point anywhere yet." },
            label: { type: ["string", "null"], description: "A short name for the executive dashboard, 2-5 words, e.g. \"Clinical Sampling / White Pellet\"." },
            nextAction: {
              type: ["string", "null"],
              description: "The single most important next step, as an instruction, e.g. \"Confirm collection technique and begin minimum-volume cell confirmation.\" Taken from the linked records' next actions; null if none is evident.",
            },
            owner: { type: ["string", "null"], description: "Who drives it, from the linked records' owners/deciders, e.g. \"Sean / Duke\"; null if not evident." },
            keyDependency: { type: ["string", "null"], description: "What progress depends on, e.g. \"Sample availability and assay plan\"; null if nothing specific." },
            decisionIds: { type: "array", items: { type: "string" }, description: "Existing open decisions that are part of answering it." },
            taskIds: { type: "array", items: { type: "string" }, description: "Tasks whose work or results inform it." },
            projectIds: { type: "array", items: { type: "string" }, description: "Whole projects that inform it (instead of listing every task)." },
            convertDecisionId: {
              type: ["string", "null"],
              description: "Only when an existing 'decision' is really a bundle of several separate choices: its id. It will be replaced by this question.",
            },
            newDecisions: {
              type: "array",
              description: "Only with convertDecisionId: the separate, specific decisions the broad one breaks into.",
              items: { type: "object", properties: { title: { type: "string" }, decider: { type: ["string", "null"] } }, required: ["title"] },
            },
            reasoning: { type: "string", description: "One or two sentences on why this is a real strategic question and why these records belong to it." },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["objectiveId", "title", "reasoning", "confidence"],
        },
      },
    },
    required: ["questions"],
  },
};

function buildPrompt(ctx: QuestionContext): string {
  const objectives = ctx.objectives.map((o) => `- id=${o.id} ${o.title}${o.description ? ` — ${o.description.slice(0, 300)}` : ""}`).join("\n");
  const decisions = ctx.decisions.length
    ? ctx.decisions.map((d) => `- id=${d.id} [${d.status}, decider ${d.decider}] ${d.title}${d.whyItMatters ? `\n    why: ${d.whyItMatters.slice(0, 300)}` : ""}`).join("\n")
    : "(none)";
  const projects = ctx.projects.map((p) => `- id=${p.id} ${p.title} (objective: ${p.objective})`).join("\n") || "(none)";
  const tasks = ctx.tasks.length
    ? ctx.tasks.map((t) => `- id=${t.id} [${t.status}] ${t.title} (project: ${t.project})${t.nextAction ? ` — next: ${t.nextAction.slice(0, 150)}` : ""}`).join("\n")
    : "(none)";
  const existing = ctx.existingQuestions.length ? ctx.existingQuestions.map((q) => `- ${q.title} (objective: ${q.objective})`).join("\n") : "(none)";

  return `You are helping an executive organize their company tracker around strategic questions: the few big open questions each objective depends on, which several decisions and pieces of work feed into. Structure: objective → strategic questions → decisions and work → evidence.

Objectives:
${objectives}

Open decisions:
${decisions}

Projects:
${projects}

Open tasks:
${tasks}

Strategic questions that already exist or are already proposed (don't repeat these):
${existing}

Propose the strategic questions that genuinely organize this work -- typically two to four per objective that has real open uncertainty, fewer where there isn't any. A good question is one where several decisions and pieces of work bear on the same underlying uncertainty (e.g. "Can we sample reliably enough for diagnostic use?" gathering needle-gauge testing, pellet analysis and low-volume DNA/RNA work). Don't make a question out of a single routine decision or task, and don't link records that merely share a topic.

When an existing "decision" is really several separate choices bundled together (e.g. "What is the highest-value clinical use case and the fastest path to exit?"), propose converting it: set convertDecisionId and list the specific decisions it breaks into as newDecisions. Otherwise leave convertDecisionId null and newDecisions empty.

Only use ids from the lists above.`;
}

// One Claude call over the whole company. Drops anything naming an unknown
// objective or record, repeating an existing question, converting a decision
// that isn't open (or converting the same one twice), or linking fewer
// than two records.
export async function proposeQuestions(ctx: QuestionContext, claudeClient: ClaudeClient = getClaudeClient()): Promise<ProposedQuestion[]> {
  if (ctx.objectives.length === 0) return [];
  const response = await claudeClient.createMessage({
    model: QUESTION_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
    tools: [TOOL],
    messages: [{ role: "user", content: buildPrompt(ctx) }],
  });
  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) return [];
  const parsed = z.object({ questions: z.array(proposalSchema) }).safeParse(toolUse.input);
  if (!parsed.success) return [];

  const objectiveIds = new Set(ctx.objectives.map((o) => o.id));
  const decisionIds = new Set(ctx.decisions.map((d) => d.id));
  const taskIds = new Set(ctx.tasks.map((t) => t.id));
  const projectIds = new Set(ctx.projects.map((p) => p.id));
  const seenTitles = ctx.existingQuestions.map((q) => titleTokens(q.title));
  const converted = new Set<string>();

  const result: ProposedQuestion[] = [];
  for (const q of parsed.data.questions) {
    if (!objectiveIds.has(q.objectiveId)) continue;
    const tokens = titleTokens(q.title);
    if (seenTitles.some((t) => titleSimilarity(t, tokens) >= LIKELY_DUPLICATE_THRESHOLD)) continue;

    let convertDecisionId = q.convertDecisionId ?? null;
    if (convertDecisionId && (!decisionIds.has(convertDecisionId) || converted.has(convertDecisionId))) convertDecisionId = null;
    const newDecisions = convertDecisionId
      ? (q.newDecisions ?? []).slice(0, MAX_NEW_DECISIONS).map((d) => ({ title: d.title.trim(), decider: d.decider?.trim() || null })).filter((d) => d.title)
      : [];
    const linkedDecisions = [...new Set(q.decisionIds ?? [])].filter((id) => decisionIds.has(id) && id !== convertDecisionId);
    const linkedTasks = [...new Set(q.taskIds ?? [])].filter((id) => taskIds.has(id));
    const linkedProjects = [...new Set(q.projectIds ?? [])].filter((id) => projectIds.has(id));
    // A question wrapping a single record is just that record; it needs at
    // least two things feeding it (or to be a conversion of a broad decision).
    if (!convertDecisionId && linkedDecisions.length + linkedTasks.length + linkedProjects.length < 2) continue;

    if (convertDecisionId) converted.add(convertDecisionId);
    seenTitles.push(tokens);
    result.push({
      objectiveId: q.objectiveId,
      title: q.title.trim(),
      hypothesis: q.hypothesis?.trim() || null,
      label: q.label?.trim() || null,
      nextAction: q.nextAction?.trim() || null,
      keyDependency: q.keyDependency?.trim() || null,
      owner: q.owner?.trim() || null,
      decisionIds: linkedDecisions,
      taskIds: linkedTasks,
      projectIds: linkedProjects,
      convertDecisionId,
      newDecisions,
      reasoning: q.reasoning,
      confidence: q.confidence,
    });
  }
  return result;
}
