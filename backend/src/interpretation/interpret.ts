import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";
import { ALLOWED_FIELDS, pickAllowedFields } from "../suggestions/apply.js";
import type { SuggestionDraft } from "./fakeInterpret.js";

export const INTERPRETATION_MODEL = "claude-sonnet-5";

// Defensive ceiling on how many propose_suggestion calls a single response can
// yield -- protects pipeline.ts (and the human reviewer's queue) from a
// degenerate response, without ever being expected to bind in normal use.
export const MAX_SUGGESTIONS_PER_SOURCE = 8;

export class InterpretationError extends Error {}

export interface InterpretSourceInput {
  subject: string;
  from: string;
  body: string;
  receivedAt: Date;
}

export interface ContextEntity {
  id: string;
  title: string;
  status: string;
}

// Decisions are narrative, not just a title/status pair -- "the CFO scope
// question" and "the CFO engagement renewal question" can only be recognized
// as the same open decision if the model also sees why each one matters and
// who is on the hook to decide, the way it can infer two task titles are the
// same from title text alone. Extends ContextEntity rather than being a
// standalone shape so isKnownEntityId's pool lookup stays uniform.
export interface DecisionContextEntity extends ContextEntity {
  decider: string;
  whyItMatters: string | null;
}

export interface CompanyContext {
  objectives: ContextEntity[];
  initiatives: ContextEntity[];
  projects: ContextEntity[];
  tasks: ContextEntity[];
  decisions: DecisionContextEntity[];
}

const changeTypeSchema = z.enum([
  "operational_update",
  "context",
  "new_task",
  "decision",
  "deadline",
  "resolved",
]);
const targetTypeSchema = z.enum(["objective", "initiative", "project", "task", "decision"]);

// Only checks shape/types -- membership of targetId in the context we actually
// handed the model, and whitelisting of proposedDiff's keys, happen afterward.
// Never trust proposedDiff blindly: it feeds directly into a DB write in
// suggestions/apply.ts.
const suggestionToolInputSchema = z.object({
  changeType: changeTypeSchema,
  targetType: targetTypeSchema,
  targetId: z.string().uuid().nullable(),
  proposedDiff: z.record(z.string(), z.unknown()),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const PROPOSE_SUGGESTION_TOOL: Anthropic.Tool = {
  name: "propose_suggestion",
  description:
    "Propose one change to the company's objective/initiative/project/task hierarchy, or a new decision that needs a human call, based on the source content and the existing context you were given. Call this tool once per distinct topic the source contains -- most sources warrant exactly one call, but you may call it more than once for a source that genuinely spans multiple unrelated topics.",
  input_schema: {
    type: "object",
    properties: {
      changeType: {
        type: "string",
        enum: changeTypeSchema.options,
        description: "The kind of change this represents.",
      },
      targetType: {
        type: "string",
        enum: targetTypeSchema.options,
        description:
          "Which level of the hierarchy this change applies to, or 'decision' if the source describes something that needs a real human call rather than a hierarchy change.",
      },
      targetId: {
        type: ["string", "null"],
        description:
          "The exact id of an existing entity from the context provided above, copied verbatim, if this updates something that already exists. null if and only if this proposes creating a brand new row.",
      },
      proposedDiff: {
        type: "object",
        description:
          "The fields to set on the target row. Include only fields that are actually changing or being set; do not restate unrelated existing fields.",
      },
      reasoning: {
        type: "string",
        description:
          "A short, specific explanation a human reviewer can scan in a few seconds: what in the source drove this, why this particular target (or why nothing existing matched), and anything the reviewer should double check. Avoid generic filler like 'this seems relevant'.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Your confidence that this is the right change to propose, from 0 to 1.",
      },
    },
    required: ["changeType", "targetType", "targetId", "proposedDiff", "reasoning", "confidence"],
  },
};

function describeAllowedFields(): string {
  return (Object.keys(ALLOWED_FIELDS) as Array<keyof typeof ALLOWED_FIELDS>)
    .map((targetType) => `- ${targetType}: ${ALLOWED_FIELDS[targetType].join(", ")}`)
    .join("\n");
}

function buildContextSection(context: CompanyContext): string {
  const section = (label: string, items: ContextEntity[]) =>
    items.length === 0
      ? `${label}: (none)`
      : `${label}:\n${items.map((item) => `- id=${item.id} status=${item.status} title="${item.title}"`).join("\n")}`;

  // Richer than `section` above: matching a follow-up to the right open
  // decision needs more than a title (see DecisionContextEntity), so each
  // line also carries decider and, when present, whyItMatters.
  const decisionsSection =
    context.decisions.length === 0
      ? "Existing open decisions: (none)"
      : `Existing open decisions:\n${context.decisions
          .map((decision) => {
            const why = decision.whyItMatters ? ` whyItMatters="${decision.whyItMatters}"` : "";
            return `- id=${decision.id} decider="${decision.decider}" title="${decision.title}"${why}`;
          })
          .join("\n")}`;

  return [
    section("Existing objectives", context.objectives),
    section("Existing initiatives", context.initiatives),
    section("Existing projects", context.projects),
    section("Existing open tasks", context.tasks),
    decisionsSection,
  ].join("\n\n");
}

export const SYSTEM_PROMPT = `You are the interpretation engine for Exvade Pulse, an internal ops tool for a clinical-stage medical device company. Exvade Pulse ingests operational communications (emails, meeting transcripts) and turns them into proposed changes to a structured hierarchy: Objectives -> Initiatives -> Projects -> Tasks. Every change you propose is reviewed by a human before it takes effect -- you are drafting a suggestion, not making the change yourself.

You will be given the company's current open objectives/initiatives/projects/tasks (each with its real id, title, and status) and one new raw source (an email or transcript excerpt). Decide the most useful change(s) to propose in response to that source, then call the propose_suggestion tool with your answer.

Most sources are about a single topic and warrant exactly one propose_suggestion call. Some sources, though -- a weekly company update, a broad meeting-minutes doc -- genuinely cover several unrelated workstreams (e.g. finance, engineering, regulatory, and grants all in one document). For a source like that, call propose_suggestion once per genuinely distinct topic/target, so each gets its own clear diff and reasoning instead of one call vaguely trying to cover everything. This is NOT license to fragment a single coherent update into many redundant calls -- one call per genuinely distinct topic or target, never one call per sentence or per minor detail within the same topic. When in doubt about whether two things are "the same topic," they usually are; only split when the topics are truly unrelated to each other.

The hardest and most important part of this job: deciding whether the source is about something already being tracked, or is genuinely new.

Strongly prefer matching the source to an EXISTING objective, initiative, project, or task over proposing a new one. Most incoming communication is a status update, a blocker, a decision, or new context on work that is already tracked -- not something brand new. Read the existing titles carefully and look for the same underlying subject matter, even if the wording differs (e.g. "rig #3 sensor issue" and "bench testing sensor dropout" are very likely the same task). If a plausible match exists, propose an update to it (targetId set to that entity's real id) rather than creating a duplicate.

Only propose creating something new (targetId: null) when nothing existing plausibly matches -- every unnecessary new_task/new project/etc. fragments the picture the company relies on and creates duplicate-tracking work for the human reviewer. When genuinely uncertain between "update this existing item" and "this is new", prefer the existing item and lower your confidence rather than defaulting to new.

Not every source calls for a change to the objective/initiative/project/task tree. Some describe something that genuinely needs a human decision -- a real choice with consequences that a specific person or group needs to make, not just a status update or a routine next action. Propose a decision (targetType: "decision") for that kind of open question. For example: "the fractional CFO engagement's scope still needs to be clarified with leadership" is a decision -- someone has to actually choose an answer. "The firmware patch passed testing" is not a decision -- it is an operational update to the relevant task, even though it is worth recording. When genuinely unsure whether something is a decision or a routine update, prefer the routine update: decisions are for real open questions that need a human call, not for every piece of news.

Once you've concluded a source is decision-shaped, apply the exact same match-before-create principle as above: check whether it's really a follow-up on an EXISTING open decision (given to you in context above, each with its id, decider, and why it matters) before proposing a brand new one. Read the existing decisions' titles and whyItMatters carefully and look for the same underlying open question, even if the wording differs (e.g. "any update on the CFO scope question?" is very likely the same open question as an existing "What should the fractional CFO engagement's scope be going forward?"). If a plausible match exists, propose an update to it (targetId set to that decision's real id) rather than creating a duplicate decision for a question that's already open. Only propose a brand-new decision (targetId: null) when nothing existing plausibly matches. When genuinely uncertain between "update this existing decision" and "this is a new decision", prefer the existing decision and lower your confidence rather than defaulting to new.

targetId rules:
- If you are proposing an update to something that already exists -- including a decision that matches one already open -- targetId MUST be the exact id string of that entity as given to you in the context above. Never invent, guess, or reformat an id.
- If you are proposing something new -- including a brand-new decision -- targetId MUST be null.

operational_update vs. context -- pick carefully, since this changes which fields your diff is allowed to touch:
- operational_update: the thing's actual current state changed -- status moved, there's a new latest-update or next-action. Use this when the source describes what IS true now.
- context: the source adds useful background, history, or color on an objective/initiative/project/task, but does NOT itself change what's currently true right now (e.g. someone explains *why* a task is stalled, or gives detail behind a status that's already recorded). A context suggestion on an objective/initiative/project/task may only set description and owner -- status/latestUpdate/nextAction/priority are silently discarded even if you include them, because a context share must never overwrite the thing's actual current state. If the source genuinely does describe a state change, use operational_update instead, not context.

proposedDiff rules -- each targetType only accepts these fields, anything else is discarded before it ever reaches the database:
${describeAllowedFields()}
(a "context" changeType is further restricted per the operational_update vs. context rule above.)
When creating a new project/initiative/task, proposedDiff must include the appropriate parent id field (initiativeId for a project, objectiveId for an initiative, projectId for a task) pointing at an existing parent from the context, plus a title. When updating an existing entity, only include the fields that are actually changing.

owner (objective/initiative/project/task only) is who's responsible for that work -- include it only when the source clearly names a specific person as doing or owning it, e.g. "Sean is handling the vendor switch." Never guess: don't default to the email's sender or any other weak proxy, and leave owner out of proposedDiff entirely when the source doesn't support it.

When proposing a brand-new decision (targetId null), proposedDiff must include title (phrased as a question or a clear decision statement -- e.g. "Which vendor should we choose for sensor boards?" or "Approve budget increase for Q4 hiring") and decider (your best guess at who should make this call -- a named person mentioned in the source, or a role like "Leadership" if no specific person is named). Include stakeholders (an array of other people who should weigh in or be informed) whenever the source names or implies any. Include whyItMatters, relevantContext, and suggestedNextStep whenever the source actually supports them -- leave a field out of proposedDiff entirely rather than inventing content the source doesn't support. dueDate and relatedTaskId are optional bonus fields: include them only when the source clearly implies one, don't force them.

When proposing an update to an existing decision (targetId set), only include the fields that actually changed based on new information in the source -- typically whyItMatters, relevantContext, and/or suggestedNextStep refreshed with what's new, and stakeholders if new people have entered the picture. Do not include decider in an update's proposedDiff: who owns a decision is a deliberate human call, not something to change via an inferred update.

reasoning must be genuinely useful for a fast human scan: name what changed, cite the specific evidence from the source, and say why you picked this target (or why you concluded nothing existing matched). Do not write generic filler.

confidence should reflect how sure you are that this specific target and diff are correct, from 0 (low) to 1 (high).`;

function buildUserMessage(source: InterpretSourceInput, context: CompanyContext): string {
  return `${buildContextSection(context)}

---

New source to interpret:
Subject: ${source.subject}
From: ${source.from}
Received: ${source.receivedAt.toISOString()}

${source.body}`;
}

function isKnownEntityId(
  targetType: z.infer<typeof targetTypeSchema>,
  id: string,
  context: CompanyContext,
): boolean {
  const pool: ContextEntity[] = {
    objective: context.objectives,
    initiative: context.initiatives,
    project: context.projects,
    task: context.tasks,
    decision: context.decisions,
  }[targetType];
  return pool.some((entity) => entity.id === id);
}

// Validates and sanitizes a single tool_use block's input. Returns the clean
// draft, or a reason string if this particular item should be dropped --
// never throws, so one bad item in a multi-item response doesn't take down
// the rest (see interpretSource).
function validateSuggestionInput(
  input: unknown,
  context: CompanyContext,
): { draft: SuggestionDraft } | { reason: string } {
  const parsed = suggestionToolInputSchema.safeParse(input);
  if (!parsed.success) {
    return { reason: `failed schema validation: ${parsed.error.message}` };
  }
  const draft = parsed.data;

  // Defensive: never trust that targetId actually refers to a real row we
  // showed the model, even though it passed schema validation as a UUID.
  if (draft.targetId !== null && !isKnownEntityId(draft.targetType, draft.targetId, context)) {
    return {
      reason: `targetId "${draft.targetId}" for targetType "${draft.targetType}" was not among the ids provided in context`,
    };
  }

  // Re-sanitize proposedDiff through the same whitelist apply.ts enforces, so
  // a malformed or adversarial tool response can't smuggle extra fields
  // through even before it gets anywhere near a DB write.
  const sanitizedDiff = pickAllowedFields(draft.targetType, draft.changeType, draft.proposedDiff);

  return {
    draft: {
      changeType: draft.changeType,
      targetType: draft.targetType,
      targetId: draft.targetId,
      proposedDiff: sanitizedDiff,
      reasoning: draft.reasoning,
      confidence: draft.confidence,
    },
  };
}

// Returns one to several SuggestionDrafts for a single source. Most sources
// yield exactly one; a genuinely multi-topic source (see SYSTEM_PROMPT) may
// yield several parallel tool_use blocks in the same response. tool_choice
// "any" forces at least one propose_suggestion call while leaving Claude's
// default parallel tool use enabled, so it can emit more than one when
// warranted -- unlike the old forced-single-tool choice, which capped it at
// exactly one no matter what the source contained.
export async function interpretSource(
  source: InterpretSourceInput,
  context: CompanyContext,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<SuggestionDraft[]> {
  const response = await claudeClient.createMessage({
    model: INTERPRETATION_MODEL,
    max_tokens: 4096,
    // SYSTEM_PROMPT is static and identical on every call; the dynamic
    // per-call content (company context + document body) lives entirely in
    // buildUserMessage below and is deliberately left uncached.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tool_choice: { type: "any" },
    tools: [PROPOSE_SUGGESTION_TOOL],
    messages: [{ role: "user", content: buildUserMessage(source, context) }],
  });

  const toolUses = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (toolUses.length === 0) {
    throw new InterpretationError("Claude did not return a structured suggestion (no tool_use block in response).");
  }

  const accepted = toolUses.slice(0, MAX_SUGGESTIONS_PER_SOURCE);
  if (toolUses.length > MAX_SUGGESTIONS_PER_SOURCE) {
    console.warn(
      `Claude returned ${toolUses.length} propose_suggestion calls for one source, exceeding the cap of ${MAX_SUGGESTIONS_PER_SOURCE}; only the first ${MAX_SUGGESTIONS_PER_SOURCE} were kept.`,
    );
  }

  const drafts: SuggestionDraft[] = [];
  for (const toolUse of accepted) {
    const result = validateSuggestionInput(toolUse.input, context);
    if ("draft" in result) {
      drafts.push(result.draft);
    } else {
      console.error(`Dropping one of ${accepted.length} propose_suggestion calls for a source: ${result.reason}`);
    }
  }

  if (drafts.length === 0) {
    throw new InterpretationError(
      `Claude returned ${accepted.length} propose_suggestion call(s), but every one failed validation.`,
    );
  }

  return drafts;
}
