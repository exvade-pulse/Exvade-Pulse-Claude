import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../db/client.js";
import {
  dateTypeEnum,
  decisions,
  initiatives,
  LIVE_DECISION_STATUSES,
  objectives,
  priorityEnum,
  projects,
  strategicQuestions,
  strategyStatusEnum,
  tasks,
  taskStatusEnum,
} from "../db/schema.js";
import { ALLOWED_FIELDS, REQUIRED_CREATE_FIELDS, type NewParent, type SuggestionTargetType } from "../suggestions/apply.js";
import type { QuestionProposal } from "../questions/manage.js";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";

// "Paste review findings": a long reviewer document (e.g. a ChatGPT audit)
// turned into individual proposals in Review. Only specific data
// corrections become proposals; software/design feedback comes back as a
// separate list for the developer. Every proposal still needs a person's
// approval.

export const FINDINGS_MODEL = "claude-sonnet-5";
// Well under what the redaction pass can echo back in one response.
export const FINDINGS_CHUNK_CHARS = 10000;
const MAX_CHANGES_PER_CHUNK = 60;
// Records the text names are shown in full: a corrected field is rewritten
// from what the AI saw, so it must see all of it.
const DETAIL_TEXT_CHARS = 6000;

type RecordType = "objective" | "initiative" | "project" | "task" | "decision";
const RECORD_TYPES: RecordType[] = ["objective", "initiative", "project", "task", "decision"];

// Splits at blank lines, headings and table rows so a finding is rarely cut
// in half; a single oversized paragraph is hard-split.
export function splitIntoChunks(text: string, max = FINDINGS_CHUNK_CHARS): string[] {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n(?=#{1,6} |\| ?[A-Z]\d{2} |\n)/);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const block of blocks) {
    if (block.length > max) {
      push();
      for (let i = 0; i < block.length; i += max) chunks.push(block.slice(i, i + max));
      continue;
    }
    if (current.length + block.length + 1 > max) push();
    current += (current ? "\n" : "") + block;
  }
  push();
  return chunks;
}

interface IndexRecord {
  type: RecordType;
  id: string;
  title: string;
  status: string;
  parent: string | null;
  parentId: string | null;
  details: Record<string, unknown>;
}

export interface FindingsContext {
  records: IndexRecord[];
  byId: Map<string, IndexRecord>;
  questions: Array<{ id: string; title: string }>;
}

export async function loadFindingsContext(db: DbOrTx, organizationId: string): Promise<FindingsContext> {
  const [objectiveRows, initiativeRows, projectRows, taskRows, decisionRows, questionRows] = await Promise.all([
    db.select().from(objectives).where(and(eq(objectives.organizationId, organizationId), ne(objectives.status, "superseded"))),
    db.select().from(initiatives).where(and(eq(initiatives.organizationId, organizationId), ne(initiatives.status, "superseded"))),
    db.select().from(projects).where(and(eq(projects.organizationId, organizationId), ne(projects.status, "superseded"))),
    db.select().from(tasks).where(and(eq(tasks.organizationId, organizationId), ne(tasks.status, "superseded"))),
    db.select().from(decisions).where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, LIVE_DECISION_STATUSES))),
    db.select({ id: strategicQuestions.id, title: strategicQuestions.title }).from(strategicQuestions).where(eq(strategicQuestions.organizationId, organizationId)),
  ]);
  const title = new Map<string, string>([...objectiveRows, ...initiativeRows, ...projectRows].map((r) => [r.id, r.title]));
  const records: IndexRecord[] = [
    ...objectiveRows.map((o) => ({ type: "objective" as const, id: o.id, title: o.title, status: o.status, parent: null, parentId: null, details: { priority: o.priority, owner: o.owner, description: o.description } })),
    ...initiativeRows.map((i) => ({ type: "initiative" as const, id: i.id, title: i.title, status: i.status, parent: title.get(i.objectiveId) ?? null, parentId: i.objectiveId, details: { priority: i.priority, owner: i.owner, description: i.description } })),
    ...projectRows.map((p) => ({ type: "project" as const, id: p.id, title: p.title, status: p.status, parent: title.get(p.initiativeId) ?? null, parentId: p.initiativeId, details: { owner: p.owner, description: p.description } })),
    ...taskRows.map((t) => ({
      type: "task" as const,
      id: t.id,
      title: t.title,
      status: t.status,
      parent: title.get(t.projectId) ?? null,
      parentId: t.projectId,
      details: {
        owner: t.owner,
        description: t.description,
        latestUpdate: t.latestUpdate,
        nextAction: t.nextAction,
        dueDate: t.dueDate ? `${t.dueDate.toISOString().slice(0, 10)} (${t.dueDateType ?? "type not set"}${t.dueLabel ? `: ${t.dueLabel}` : ""})` : null,
        waitingFor: t.waitingFor,
      },
    })),
    ...decisionRows.map((d) => ({
      type: "decision" as const,
      id: d.id,
      title: d.title,
      status: d.status,
      parent: null,
      parentId: null,
      details: {
        decider: d.decider,
        stakeholders: d.stakeholders,
        dueDate: d.dueDate ? d.dueDate.toISOString().slice(0, 10) : null,
        whyItMatters: d.whyItMatters,
        relevantContext: d.relevantContext,
        suggestedNextStep: d.suggestedNextStep,
      },
    })),
  ];
  return { records, byId: new Map(records.map((r) => [r.id, r])), questions: questionRows };
}

// Records a chunk names by full id (as in a Pulse link) or by an 8-hex
// prefix like `fac335f9`.
export function referencedRecords(chunk: string, ctx: FindingsContext): IndexRecord[] {
  const found = new Map<string, IndexRecord>();
  for (const m of chunk.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
    const r = ctx.byId.get(m[0].toLowerCase());
    if (r) found.set(r.id, r);
  }
  for (const m of chunk.matchAll(/`([0-9a-f]{8})`|\b([0-9a-f]{8})\b/gi)) {
    const prefix = (m[1] ?? m[2]).toLowerCase();
    const matches = ctx.records.filter((r) => r.id.startsWith(prefix));
    if (matches.length === 1) found.set(matches[0].id, matches[0]);
  }
  // ...or by a distinctive title quoted in the text.
  const lower = chunk.toLowerCase();
  for (const r of ctx.records) {
    if (r.title.length >= 12 && lower.includes(r.title.toLowerCase())) found.set(r.id, r);
  }
  return [...found.values()];
}

function clip(value: unknown): string {
  const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  return text.length > DETAIL_TEXT_CHARS ? `${text.slice(0, DETAIL_TEXT_CHARS)}…` : text;
}

function buildPrompt(chunk: string, ctx: FindingsContext, part: string): string {
  const index = RECORD_TYPES.map(
    (type) =>
      `${type.toUpperCase()}S:\n` +
      ctx.records
        .filter((r) => r.type === type)
        .map((r) => `- id=${r.id} [${r.status}${type === "objective" ? `, ${r.details.priority}` : ""}] ${r.title}${r.parent ? ` (under: ${r.parent})` : ""}`)
        .join("\n"),
  ).join("\n\n");
  const referenced = referencedRecords(chunk, ctx);
  const details = referenced.length
    ? referenced
        .map((r) =>
          [
            `${r.type} id=${r.id} status=${r.status} title="${r.title}"${r.parent ? ` under="${r.parent}"` : ""}`,
            ...Object.entries(r.details)
              .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
              .map(([k, v]) => `  ${k}: ${clip(v)}`),
          ].join("\n"),
        )
        .join("\n\n")
    : "(no specific records linked in this part)";
  const questions = ctx.questions.length ? ctx.questions.map((q) => `- ${q.title}`).join("\n") : "(none)";

  return `A reviewer audited Exvade Pulse (the company's operations tracker) and wrote findings. Below is ${part} of their document. Turn every SPECIFIC correction to Pulse's data into proposed changes, and list software/design feedback separately. A person approves each proposal, so be precise and conservative.

Rules:
- Only propose what the text specifically calls for, against the records it names. Cite the finding id (e.g. "C07") when there is one.
- Never state as fact anything the reviewer marks as unverified ("verify", "unknown", "to confirm", "requires verification"). Where a record currently asserts something the reviewer says is unsupported, propose rewording that states the uncertainty, and set needsVerification with what must be checked.
- Don't close or cancel anything unless the text says it is confirmed complete or no longer relevant. Age is never a reason. Superseding a duplicate is a merge, not a closure.
- One "update" per record per part: combine all field changes for it.
- A changed text field (description, latestUpdate, relevantContext, etc.) replaces the whole field, so return its complete new value: keep everything in it that is still correct and change only what the finding addresses. Don't prefix it with "Correction:" or narrate the change; write it as the record should read. Only change fields of records whose full current values are shown below.
- To move a task, update its projectId to an existing project id. If the text names an initiative (not a project) as a task's destination, set projectId to that initiative's id; Pulse files the task in a project inside it. To change importance, update an objective's priority (low/medium/high/critical).
- Create an initiative/project only when the text calls for a new grouping and nothing existing fits. Create an objective only when the text explicitly asks for a new top-level objective or outcome. Nothing can be moved into something created in the same run, so say in the reasoning what should move once it exists.
- Strategic questions: propose them when the text names them, with linked record ids.
- Pure software, layout, navigation or design feedback (e.g. "show snippets in search", "dates render a day early") goes in appFeedback, not changes.
- Use only ids from the lists below.
- Account for every specific instruction: each one becomes a change, or goes in unresolved with the reason (e.g. no record by that name, it may have been merged; destination doesn't exist yet).

--- Records the text links to (full current values) ---
${details}

--- All records (index) ---
${index}

--- Existing strategic questions ---
${questions}

--- Reviewer text (${part}) ---
${chunk}`;
}

const updateFieldsDescription = Object.entries(ALLOWED_FIELDS)
  .filter(([type]) => RECORD_TYPES.includes(type as RecordType))
  .map(([type, fields]) => `${type}: ${fields.join(", ")}`)
  .join("; ");

const TOOL: Anthropic.Tool = {
  name: "propose_corrections",
  description: "Propose specific data corrections from a reviewer's findings, and list software/design feedback separately.",
  input_schema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["update", "create", "merge", "question"] },
            finding: { type: ["string", "null"], description: "The reviewer's finding id, e.g. C07, if any." },
            targetType: { type: "string", enum: RECORD_TYPES, description: "For update/create/merge." },
            targetId: { type: ["string", "null"], description: "update: the record to change. merge: the duplicate to supersede." },
            keepId: { type: ["string", "null"], description: "merge only: the record to keep." },
            fields: { type: "object", description: `update/create: the fields to set. Allowed per type: ${updateFieldsDescription}. Parent ids (objectiveId/initiativeId/projectId) must be existing ids.` },
            question: {
              type: ["object", "null"],
              description: "question only.",
              properties: {
                objectiveId: { type: "string" },
                title: { type: "string" },
                label: { type: ["string", "null"] },
                hypothesis: { type: ["string", "null"] },
                nextAction: { type: ["string", "null"] },
                owner: { type: ["string", "null"] },
                keyDependency: { type: ["string", "null"] },
                decisionIds: { type: "array", items: { type: "string" } },
                taskIds: { type: "array", items: { type: "string" } },
                projectIds: { type: "array", items: { type: "string" } },
              },
            },
            needsVerification: { type: "boolean" },
            verifyNote: { type: ["string", "null"], description: "What a person must confirm before or after approving." },
            reasoning: { type: "string", description: "One or two sentences: what the reviewer found and why this change follows." },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["action", "reasoning", "confidence"],
        },
      },
      unresolved: {
        type: "array",
        description: "Specific instructions in the text that you could not turn into a change.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "The instruction, shortened if long." },
            reason: { type: "string", description: "Why, in plain words." },
          },
          required: ["text", "reason"],
        },
      },
      appFeedback: {
        type: "array",
        items: {
          type: "object",
          properties: {
            area: { type: "string", description: "Page or feature, e.g. Executive, Search, Decisions." },
            issue: { type: "string" },
            suggestion: { type: ["string", "null"] },
            priority: { type: "string", enum: ["must", "should", "nice"] },
          },
          required: ["area", "issue", "priority"],
        },
      },
    },
    required: ["changes", "unresolved", "appFeedback"],
  },
};

const changeSchema = z.object({
  action: z.enum(["update", "create", "merge", "question"]),
  finding: z.string().nullable().optional(),
  targetType: z.enum(["objective", "initiative", "project", "task", "decision"]).optional(),
  targetId: z.string().nullable().optional(),
  keepId: z.string().nullable().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  question: z
    .object({
      objectiveId: z.string(),
      title: z.string().min(1),
      label: z.string().nullable().optional(),
      hypothesis: z.string().nullable().optional(),
      nextAction: z.string().nullable().optional(),
      owner: z.string().nullable().optional(),
      keyDependency: z.string().nullable().optional(),
      decisionIds: z.array(z.string()).optional(),
      taskIds: z.array(z.string()).optional(),
      projectIds: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  needsVerification: z.boolean().optional(),
  verifyNote: z.string().nullable().optional(),
  reasoning: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const unresolvedSchema = z.object({ text: z.string().min(1), reason: z.string().min(1) });

export interface UnresolvedItem {
  text: string;
  reason: string;
}

const feedbackSchema = z.object({ area: z.string(), issue: z.string(), suggestion: z.string().nullable().optional(), priority: z.enum(["must", "should", "nice"]) });

interface Meta {
  finding: string | null;
  needsVerification: boolean;
  verifyNote: string | null;
  reasoning: string;
  confidence: number;
}

export type FindingProposal =
  | ({ kind: "update"; targetType: RecordType; targetId: string; fields: Record<string, unknown> } & Meta)
  | ({ kind: "create"; targetType: RecordType; fields: Record<string, unknown> } & Meta)
  | ({ kind: "merge"; targetType: RecordType; duplicateId: string; keepId: string } & Meta)
  | ({ kind: "question"; proposal: QuestionProposal } & Meta);

export interface AppFeedbackItem {
  area: string;
  issue: string;
  suggestion: string | null;
  priority: "must" | "should" | "nice";
}

const ENUMS: Record<string, readonly string[]> = {
  "task.status": taskStatusEnum.enumValues,
  "task.dueDateType": dateTypeEnum.enumValues,
  "objective.status": strategyStatusEnum.enumValues,
  "initiative.status": strategyStatusEnum.enumValues,
  "project.status": strategyStatusEnum.enumValues,
  "objective.priority": priorityEnum.enumValues,
  "initiative.priority": priorityEnum.enumValues,
};
const TEXT_FIELDS = new Set(["description", "latestUpdate", "nextAction", "whyItMatters", "relevantContext", "suggestedNextStep"]);
const PARENT_FIELD: Record<string, RecordType> = { objectiveId: "objective", initiativeId: "initiative", projectId: "project", relatedTaskId: "task" };

// Whitelists fields, checks enum values and that any parent id is a real
// record of the right type. Returns null if nothing valid is left.
function cleanFields(type: RecordType, raw: Record<string, unknown>, ctx: FindingsContext): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_FIELDS[type as SuggestionTargetType]) {
    if (!(key in raw)) continue;
    const value = raw[key];
    const allowed = ENUMS[`${type}.${key}`];
    if (allowed && !allowed.includes(String(value))) continue;
    if (key in PARENT_FIELD) {
      const parent = typeof value === "string" ? ctx.byId.get(value) : undefined;
      if (!parent || parent.type !== PARENT_FIELD[key]) continue;
    }
    if ((key === "dueDate" || key === "followUpOn") && value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) continue;
    if (key === "stakeholders" && !Array.isArray(value)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// A task "moved into an initiative" goes into that initiative's only
// project, or else into a project named after the initiative, created when
// the card is approved (see suggestions/apply.ts's NewParent; an existing
// one by that name is reused). Mutates raw; returns the new destination.
function routeTaskIntoInitiative(type: string | undefined, raw: Record<string, unknown>, ctx: FindingsContext): NewParent | null {
  if (type !== "task" || typeof raw.projectId !== "string") return null;
  const initiative = ctx.byId.get(raw.projectId);
  if (!initiative || initiative.type !== "initiative") return null;
  const inside = ctx.records.filter((r) => r.type === "project" && r.parentId === initiative.id);
  if (inside.length === 1) {
    raw.projectId = inside[0].id;
    return null;
  }
  delete raw.projectId;
  return { title: initiative.title, parentId: initiative.id };
}

export async function proposeFromFindings(
  chunk: string,
  ctx: FindingsContext,
  part: string,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<{ proposals: FindingProposal[]; appFeedback: AppFeedbackItem[]; unresolved: UnresolvedItem[] }> {
  const response = await claudeClient.createMessage({
    model: FINDINGS_MODEL,
    // Room for up to MAX_CHANGES_PER_CHUNK changes; kept under the SDK's
    // ceiling for a non-streaming request.
    max_tokens: 20000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tool_choice: { type: "auto" },
    tools: [TOOL],
    messages: [{ role: "user", content: buildPrompt(chunk, ctx, part) }],
  });
  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) return { proposals: [], appFeedback: [], unresolved: [{ text: `All of ${part}`, reason: "The AI step returned no result; try pasting it again." }] };
  const input = toolUse.input as { changes?: unknown[]; unresolved?: unknown[]; appFeedback?: unknown[] };

  const unresolved: UnresolvedItem[] = (input.unresolved ?? [])
    .map((u) => unresolvedSchema.safeParse(u))
    .filter((r) => r.success)
    .map((r) => r.data!);
  // A change the AI proposed that Pulse can't apply is reported, not dropped silently.
  const drop = (c: { reasoning?: string; targetId?: string | null }, reason: string) => {
    const name = c.targetId ? ctx.byId.get(c.targetId)?.title : undefined;
    unresolved.push({ text: name ? `"${name}": ${c.reasoning ?? ""}`.trim() : (c.reasoning ?? "A proposed change"), reason });
  };
  const changes = input.changes ?? [];
  if (changes.length > MAX_CHANGES_PER_CHUNK) {
    unresolved.push({ text: `${changes.length - MAX_CHANGES_PER_CHUNK} more changes in ${part}`, reason: `Over the limit of ${MAX_CHANGES_PER_CHUNK} per part; paste them again separately.` });
  }

  const appFeedback: AppFeedbackItem[] = (input.appFeedback ?? [])
    .map((f) => feedbackSchema.safeParse(f))
    .filter((r) => r.success)
    .map((r) => ({ ...r.data!, suggestion: r.data!.suggestion ?? null }));

  const proposals: FindingProposal[] = [];
  const updated = new Set<string>();
  // Rewriting a text field is only safe for a record whose full current
  // text the AI was shown.
  const shownInFull = new Set(referencedRecords(chunk, ctx).map((r) => r.id));
  for (const raw of changes.slice(0, MAX_CHANGES_PER_CHUNK)) {
    const parsed = changeSchema.safeParse(raw);
    if (!parsed.success) continue;
    const c = parsed.data;
    const newParent = c.fields ? routeTaskIntoInitiative(c.targetType, c.fields, ctx) : null;
    const meta: Meta = {
      finding: c.finding?.trim() || null,
      needsVerification: !!c.needsVerification,
      verifyNote: c.verifyNote?.trim() || null,
      reasoning: c.reasoning,
      confidence: c.confidence,
    };
    if (c.action === "update") {
      const target = c.targetId ? ctx.byId.get(c.targetId) : undefined;
      if (!target || target.type !== c.targetType) {
        drop(c, "No record with that name was found (it may have been merged or renamed).");
        continue;
      }
      if (updated.has(target.id)) continue;
      const cleaned = cleanFields(target.type, c.fields ?? {}, ctx);
      let fields = cleaned && !shownInFull.has(target.id) ? Object.fromEntries(Object.entries(cleaned).filter(([k]) => !TEXT_FIELDS.has(k))) : cleaned;
      if (newParent) fields = { ...(fields ?? {}), newParent };
      if (!fields || Object.keys(fields).length === 0) {
        drop(c, "Nothing Pulse could apply: the destination or values didn't match an existing record.");
        continue;
      }
      updated.add(target.id);
      proposals.push({ kind: "update", targetType: target.type, targetId: target.id, fields, ...meta });
    } else if (c.action === "create") {
      if (!c.targetType) continue;
      const cleaned = cleanFields(c.targetType, c.fields ?? {}, ctx);
      const fields = newParent ? { ...(cleaned ?? {}), newParent } : cleaned;
      const required = (c.targetType === "decision" ? ["title", "decider"] : REQUIRED_CREATE_FIELDS[c.targetType]).filter((k) => !(newParent && k === "projectId"));
      const missing = fields ? required.filter((k) => !(k in fields)) : required;
      if (!fields || missing.length > 0) {
        const title = typeof c.fields?.title === "string" ? `New ${c.targetType} "${c.fields.title}"` : undefined;
        unresolved.push({ text: title ?? c.reasoning, reason: `Missing or unrecognised ${missing.join(", ") || "fields"} (e.g. the place it should go doesn't exist).` });
        continue;
      }
      proposals.push({ kind: "create", targetType: c.targetType, fields, ...meta });
    } else if (c.action === "merge") {
      const dup = c.targetId ? ctx.byId.get(c.targetId) : undefined;
      const keep = c.keepId ? ctx.byId.get(c.keepId) : undefined;
      if (!dup || !keep || dup.id === keep.id || dup.type !== keep.type) {
        drop(c, "Couldn't match both records of this merge (one may already be merged).");
        continue;
      }
      proposals.push({ kind: "merge", targetType: dup.type, duplicateId: dup.id, keepId: keep.id, ...meta });
    } else if (c.action === "question" && c.question) {
      const q = c.question;
      const objective = ctx.byId.get(q.objectiveId);
      if (!objective || objective.type !== "objective") {
        unresolved.push({ text: q.title, reason: "No objective by that name to put this question under." });
        continue;
      }
      const ofType = (ids: string[] | undefined, type: RecordType) => [...new Set(ids ?? [])].filter((id) => ctx.byId.get(id)?.type === type);
      proposals.push({
        kind: "question",
        proposal: {
          objectiveId: objective.id,
          title: q.title.trim(),
          hypothesis: q.hypothesis?.trim() || null,
          label: q.label?.trim() || null,
          nextAction: q.nextAction?.trim() || null,
          owner: q.owner?.trim() || null,
          keyDependency: q.keyDependency?.trim() || null,
          decisionIds: ofType(q.decisionIds, "decision"),
          taskIds: ofType(q.taskIds, "task"),
          projectIds: ofType(q.projectIds, "project"),
          convertDecisionId: null,
          newDecisions: [],
        },
        ...meta,
      });
    }
  }
  return { proposals, appFeedback, unresolved };
}
