import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";
import { ALLOWED_FIELDS, pickAllowedFields, REQUIRED_CREATE_FIELDS } from "../suggestions/apply.js";
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
  // Verbatim quotes from the source, required whenever proposedDiff sets a
  // "protected" field (owner/status on a hierarchy target, dueDate on a
  // decision) -- see quotesGroundedInSource. Optional at the schema level
  // since most suggestions don't touch a protected field and have nothing to
  // cite; defaulted to [] so downstream code never has to null-check it.
  evidenceQuotes: z.array(z.string()).optional().default([]),
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
      evidenceQuotes: {
        type: "array",
        items: { type: "string" },
        description:
          "Verbatim quotes copied directly from the source text (not paraphrased) that support any of the following IF present in proposedDiff: owner, status, or dueDate. Required whenever proposedDiff sets one of those fields -- if you can't quote text that actually supports it, don't set the field. Omit or leave empty when proposedDiff doesn't touch any of those three fields.",
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

Topical similarity alone is not the only signal for whether something deserves its own call, though. Within what reads as one broad status update, a specific action item with its own named owner and its own concrete deliverable (e.g. "finalize remaining charges -- Harold/Sean", "schedule review meeting -- Nassir/Sean", "CO for assembly sample sizes -- Sean/Don") is worth its own new_task or operational_update call even if it shares a parent theme with other items in the same paragraph -- a distinct owner and a distinct deliverable is what makes something individually trackable and assignable, which is the whole point of this system, and lumping several of those into one context update on the parent initiative loses that. Reserve a single broad context/operational_update call for content that is genuinely just narrative color with no separately actionable, separately owned piece inside it.

Use your extended thinking to actually work through this before calling the tool: identify every distinct action item in the source first (what is it, who owns it, is it new or a continuation of something tracked), decide for each one individually whether it matches an existing objective/initiative/project/task or is genuinely new, and only then make your propose_suggestion call(s). Since every source reaching you has already passed a cheaper noise filter, you should almost always find at least one real, worthwhile call to make -- responding with nothing is the rare exception, not a safe default when a source is merely hard to parse.

The hardest and most important part of this job: deciding whether the source is about something already being tracked, or is genuinely new.

Strongly prefer matching the source to an EXISTING objective, initiative, project, or task over proposing a new one. Most incoming communication is a status update, a blocker, a decision, or new context on work that is already tracked -- not something brand new. Read the existing titles carefully and look for the same underlying subject matter, even if the wording differs (e.g. "rig #3 sensor issue" and "bench testing sensor dropout" are very likely the same task). If a plausible match exists, propose an update to it (targetId set to that entity's real id) rather than creating a duplicate.

Only propose creating something new (targetId: null) when nothing existing plausibly matches -- every unnecessary new_task/new project/etc. fragments the picture the company relies on and creates duplicate-tracking work for the human reviewer. When genuinely uncertain between "update this existing item" and "this is new", prefer the existing item and lower your confidence rather than defaulting to new.

A task needs a real, existing project to attach to (proposedDiff.projectId must reference a project id given to you in context) -- you cannot create a task under a project, initiative, or objective that doesn't exist yet in the same call. When a source names a specific, individually actionable, individually owned item (a distinct deliverable with a named owner) but its real workstream has no project yet, do not fall back to describing it only in prose on some other entity's context/operational_update -- instead propose the task as a new_task under the project literally titled "Unsorted / Needs Triage" (it always exists for exactly this purpose), so it's still tracked as its own item with its own owner and status rather than buried in someone else's description text. Say in your reasoning that it belongs somewhere else once that structure exists, so a human knows to re-file it later. Reserve the "describe it in the parent's context/operational_update instead" approach for content that is genuinely just narrative color, not a separately-owned action item.

Not every source calls for a change to the objective/initiative/project/task tree. Some describe something that genuinely needs a human decision -- a real choice with consequences that a specific person or group needs to make, not just a status update or a routine next action. Propose a decision (targetType: "decision") for that kind of open question. For example: "the fractional CFO engagement's scope still needs to be clarified with leadership" is a decision -- someone has to actually choose an answer. "The firmware patch passed testing" is not a decision -- it is an operational update to the relevant task, even though it is worth recording. When genuinely unsure whether something is a decision or a routine update, prefer the routine update: decisions are for real open questions that need a human call, not for every piece of news.

Once you've concluded a source is decision-shaped, apply the exact same match-before-create principle as above: check whether it's really a follow-up on an EXISTING open decision (given to you in context above, each with its id, decider, and why it matters) before proposing a brand new one. Read the existing decisions' titles and whyItMatters carefully and look for the same underlying open question, even if the wording differs (e.g. "any update on the CFO scope question?" is very likely the same open question as an existing "What should the fractional CFO engagement's scope be going forward?"). If a plausible match exists, propose an update to it (targetId set to that decision's real id) rather than creating a duplicate decision for a question that's already open. Only propose a brand-new decision (targetId: null) when nothing existing plausibly matches. When genuinely uncertain between "update this existing decision" and "this is a new decision", prefer the existing decision and lower your confidence rather than defaulting to new.

targetId rules:
- If you are proposing an update to something that already exists -- including a decision that matches one already open -- targetId MUST be the exact id string of that entity as given to you in the context above. Never invent, guess, or reformat an id.
- If you are proposing something new -- including a brand-new decision -- targetId MUST be null.

operational_update vs. context -- pick carefully, since this changes which fields your diff is allowed to touch:
- operational_update: the thing's actual current state changed -- status moved, there's a new latest-update or next-action. Use this when the source describes what IS true now.
- context: the source adds useful background, history, or color on an objective/initiative/project/task, but does NOT itself change what's currently true right now (e.g. someone explains *why* a task is stalled, or gives detail behind a status that's already recorded). A context suggestion on an objective/initiative/project/task may only set description and owner -- status/latestUpdate/nextAction/priority are silently discarded even if you include them, because a context share must never overwrite the thing's actual current state. If the source genuinely does describe a state change, use operational_update instead, not context.

Evidence requirement for owner/status/dueDate: these three fields get silently dropped from your proposedDiff after the fact unless evidenceQuotes contains a verbatim quote from the source that actually supports the value -- so don't bother setting owner, status, or dueDate unless you can also quote the exact text that justifies it. A quote must be copied directly from the source, not paraphrased or invented, or it won't be recognized as support. This applies to every changeType, not just context -- an operational_update proposing status: "blocked" needs the same evidence as anything else.

Do not write the source's own ingestion date (given to you above as "Received: ...") into description/latestUpdate/nextAction/whyItMatters/relevantContext/suggestedNextStep as if the source itself stated that date -- e.g. don't produce "As of September 14, 2026, the vendor confirmed..." just because that happens to be when this message arrived. Only include a specific date in that kind of narrative text when the source body itself actually states it.

Two related reading traps to watch for, since getting either wrong writes something false into the company's record of what's actually true right now:

1. Planned vs. happened. "Don will run the test," "we're planning to ship Friday," "the review is scheduled for next week" describes an intention or a future plan, not a completed action. Never propose status: "completed"/"resolved" (or phrase latestUpdate as if it already happened) purely because someone said it's going to happen. Only treat something as done when the source states it actually happened, as a past-tense fact -- "the test passed" is evidence of completion; "the test is scheduled for Friday," even about the exact same test, is not.

2. Negation and correction. A source can state that something did NOT happen, was cancelled, was delayed, or corrects an earlier claim ("actually, that wasn't finished after all"). Read for this carefully: a sentence containing a completed-sounding phrase inside a negation ("this was not completed," "the test did not pass") is evidence AGAINST that status, not evidence for it -- don't pattern-match on the presence of "completed" alone. When a source corrects or negates something previously reported, treat the corrected/negated version as the current truth, and say so in reasoning (e.g. "source corrects an earlier report that X was done -- it was not").

If either of these makes the right call genuinely ambiguous, lower your confidence and say why in reasoning rather than guessing.

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

// The fields the model can't set without pointing at supporting text -- the
// same owner/status pair across every targetType except "decision", which
// uses dueDate instead (a decision has no owner/status field of its own;
// decider/stakeholders are a deliberate human call, not something an
// inferred update should touch).
const PROTECTED_HIERARCHY_FIELDS = ["owner", "status"] as const;
const PROTECTED_DECISION_FIELDS = ["dueDate"] as const;

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// True only if at least one quote is both non-empty and actually a substring
// of the source body (whitespace/case-insensitive) -- a paraphrase or an
// invented quote won't match, which is the point: this can't be satisfied by
// the model merely asserting it has evidence.
function quotesGroundedInSource(quotes: string[], sourceBody: string): boolean {
  const normalizedSource = normalizeForMatch(sourceBody);
  return quotes.some((quote) => {
    const normalizedQuote = normalizeForMatch(quote);
    return normalizedQuote.length > 0 && normalizedSource.includes(normalizedQuote);
  });
}

// Drops owner/status (or dueDate, for a decision) from the diff in place
// when no quoted evidence actually grounds them in the source -- the rest of
// the diff (and the suggestion as a whole) still goes through. Mutates and
// returns the same object rather than the usual immutable style, since the
// caller already treats sanitizedDiff as a fresh object it owns.
function stripUngroundedProtectedFields(
  targetType: z.infer<typeof targetTypeSchema>,
  diff: Record<string, unknown>,
  evidenceQuotes: string[],
  sourceBody: string,
): Record<string, unknown> {
  const protectedFields = targetType === "decision" ? PROTECTED_DECISION_FIELDS : PROTECTED_HIERARCHY_FIELDS;
  const touchesProtectedField = protectedFields.some((field) => field in diff);
  if (!touchesProtectedField) return diff;

  if (!quotesGroundedInSource(evidenceQuotes, sourceBody)) {
    for (const field of protectedFields) delete diff[field];
  }
  return diff;
}

// Narrative fields per targetType that stripFabricatedIngestionDate checks --
// everything else in ALLOWED_FIELDS is either structural (title, ids) or
// already covered by the protected-field check above.
const NARRATIVE_FIELDS_BY_TARGET: Partial<Record<z.infer<typeof targetTypeSchema>, string[]>> = {
  objective: ["description"],
  initiative: ["description"],
  project: ["description"],
  task: ["description", "latestUpdate", "nextAction"],
  decision: ["whyItMatters", "relevantContext", "suggestedNextStep"],
};

// A handful of common renderings of the same calendar date -- enough to catch
// "the model restated its own ingestion timestamp as prose" without needing
// real date parsing, which narrative text is too free-form for anyway.
function receivedAtDateVariants(receivedAt: Date): string[] {
  return [
    receivedAt.toISOString().slice(0, 10),
    receivedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    receivedAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
  ];
}

// True when `text` contains the source's own ingestion date rendered as
// prose, AND that date string does not itself appear anywhere in the source
// body -- i.e. the source never said this date, but the model wrote it in
// anyway, most likely by mistaking "when this arrived" for "a fact the
// source stated." A source that genuinely does mention its own received date
// (e.g. "as discussed on today's call") is left alone, since the date really
// is grounded in that case.
function containsFabricatedIngestionDate(text: string, receivedAt: Date, sourceBody: string): boolean {
  const normalizedText = normalizeForMatch(text);
  const normalizedSourceBody = normalizeForMatch(sourceBody);
  return receivedAtDateVariants(receivedAt).some((variant) => {
    const normalizedVariant = normalizeForMatch(variant);
    return normalizedText.includes(normalizedVariant) && !normalizedSourceBody.includes(normalizedVariant);
  });
}

// Drops (whole-field, not a surgical edit) any narrative field whose text
// contains a fabricated ingestion date -- see containsFabricatedIngestionDate.
// Deleting the field rather than trying to excise just the date avoids
// leaving a mangled sentence behind; the rest of the diff is unaffected.
function stripFieldsWithFabricatedDates(
  targetType: z.infer<typeof targetTypeSchema>,
  diff: Record<string, unknown>,
  receivedAt: Date,
  sourceBody: string,
): Record<string, unknown> {
  const narrativeFields = NARRATIVE_FIELDS_BY_TARGET[targetType] ?? [];
  for (const field of narrativeFields) {
    const value = diff[field];
    if (typeof value === "string" && containsFabricatedIngestionDate(value, receivedAt, sourceBody)) {
      delete diff[field];
    }
  }
  return diff;
}

// Validates and sanitizes a single tool_use block's input. Returns the clean
// draft, or a reason string if this particular item should be dropped --
// never throws, so one bad item in a multi-item response doesn't take down
// the rest (see interpretSource).
function validateSuggestionInput(
  input: unknown,
  context: CompanyContext,
  source: InterpretSourceInput,
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
  let sanitizedDiff = pickAllowedFields(draft.targetType, draft.changeType, draft.proposedDiff);
  sanitizedDiff = stripUngroundedProtectedFields(draft.targetType, sanitizedDiff, draft.evidenceQuotes, source.body);
  sanitizedDiff = stripFieldsWithFabricatedDates(draft.targetType, sanitizedDiff, source.receivedAt, source.body);

  // A brand-new row (targetId null) missing its required parent id/title
  // would fail the target table's own NOT NULL constraint at approval time
  // no matter how many times it's retried -- reject it here instead of
  // storing a suggestion that can never actually be approved. Decisions have
  // their own required-field check in apply.ts's createDecision path.
  if (draft.targetId === null && draft.targetType !== "decision") {
    const missing = REQUIRED_CREATE_FIELDS[draft.targetType].filter((key) => !(key in sanitizedDiff));
    if (missing.length > 0) {
      return {
        reason: `proposes a new ${draft.targetType} but proposedDiff is missing required field(s) ${missing.join(", ")}`,
      };
    }
  }

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
// is deliberately "auto", not the old forced "any": Sonnet 5 only runs
// extended thinking when tool_choice is auto (empirically verified -- forced
// tool use returns zero thinking tokens regardless of the thinking param),
// and giving the model room to actually reason before deciding how to split
// a multi-topic source into distinct, correctly-matched items is the whole
// point of this pass. The SYSTEM_PROMPT's "always call the tool" guidance
// below is what keeps this from regressing to text-only non-answers now that
// nothing structurally forces a tool call -- and if it ever does, pipeline.ts
// already treats that identically to "found nothing worth proposing", not a
// crash.
export async function interpretSource(
  source: InterpretSourceInput,
  context: CompanyContext,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<SuggestionDraft[]> {
  const response = await claudeClient.createMessage({
    model: INTERPRETATION_MODEL,
    // Extended thinking plus a document with several distinct items needs
    // real headroom -- 4096 was sized for tool-call output alone.
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    // Deliberately the platform default ("high"), not xhigh -- measured
    // against real documents, xhigh let thinking run away on some inputs
    // (observed: 15999 of a 16000 max_tokens budget spent entirely on
    // thinking, response cut off mid-thought with stop_reason "max_tokens"
    // and zero tool_use output, on a document with a genuinely small
    // context). "high" is what every successful interpretation call this
    // session has run under before thinking was even enabled, so it's the
    // proven-stable choice; revisit only alongside raising max_tokens and
    // switching to a streaming call (large max_tokens needs streaming to
    // avoid non-streaming HTTP timeouts).
    output_config: { effort: "high" },
    // SYSTEM_PROMPT is static and identical on every call; the dynamic
    // per-call content (company context + document body) lives entirely in
    // buildUserMessage below and is deliberately left uncached.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tool_choice: { type: "auto" },
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
    const result = validateSuggestionInput(toolUse.input, context, source);
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
