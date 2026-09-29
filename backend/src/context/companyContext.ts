import type Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { Database, DbOrTx } from "../db/client.js";
import {
  auditLog,
  companyContext,
  companyEntities,
  decisions,
  initiatives,
  LIVE_DECISION_STATUSES,
  objectives,
  projects,
  sources,
  strategicQuestions,
  suggestions,
  tasks,
} from "../db/schema.js";
import { getClaudeClient, type ClaudeClient } from "../interpretation/claudeClient.js";

// Long enough for a real profile, short enough that it stays cheap to send
// with every AI call.
export const COMPANY_CONTEXT_MAX_CHARS = 12000;
export const CONTEXT_DRAFT_MODEL = "claude-sonnet-5";

export class CompanyContextError extends Error {}

export async function loadCompanyContext(db: DbOrTx, organizationId: string) {
  const [row] = await db.select().from(companyContext).where(eq(companyContext.organizationId, organizationId));
  return row ?? null;
}

// Saves a new version; the previous one goes into the audit log so nothing
// the team wrote is ever lost.
export async function saveCompanyContext(db: Database, params: { organizationId: string; actorId: string; content: string }) {
  const content = params.content.trim();
  if (content.length > COMPANY_CONTEXT_MAX_CHARS) {
    throw new CompanyContextError(`Keep it under ${COMPANY_CONTEXT_MAX_CHARS.toLocaleString()} characters (it's ${content.length.toLocaleString()})`);
  }
  return db.transaction(async (tx) => {
    const previous = await loadCompanyContext(tx, params.organizationId);
    const now = new Date();
    const [saved] = await tx
      .insert(companyContext)
      .values({ organizationId: params.organizationId, content, updatedBy: params.actorId, updatedAt: now })
      .onConflictDoUpdate({ target: companyContext.organizationId, set: { content, updatedBy: params.actorId, updatedAt: now } })
      .returning();
    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "company_context.updated",
      entityType: "company_context",
      entityId: params.organizationId,
      details: { previousContent: previous?.content ?? null, length: content.length },
    });
    return saved;
  });
}

const CONTEXT_PREAMBLE =
  "Company context, written by the team. Use it to recognize names, programs, partners, abbreviations and priorities. It is background only: it is not evidence that anything happened, it never overrides what the source itself says, and it is not a reason to propose a change on its own.";

// Wraps a Claude client so every call also carries the company context as
// an extra system block (after the call's own system prompt, so each
// prompt's cached prefix is unchanged). No context, no change.
export function withCompanyContext(client: ClaudeClient, content: string | null | undefined): ClaudeClient {
  const text = content?.trim();
  if (!text) return client;
  const block: Anthropic.TextBlockParam = {
    type: "text",
    text: `${CONTEXT_PREAMBLE}\n\n<company_context>\n${text}\n</company_context>`,
    cache_control: { type: "ephemeral" },
  };
  return {
    createMessage(params) {
      const existing: Anthropic.TextBlockParam[] =
        params.system === undefined ? [] : typeof params.system === "string" ? [{ type: "text", text: params.system }] : params.system;
      return client.createMessage({ ...params, system: [...existing, block] });
    },
  };
}

// The Claude client for one organization's AI work, with its context.
export async function getContextualClaudeClient(db: DbOrTx, organizationId: string, base: ClaudeClient = getClaudeClient()) {
  const row = await loadCompanyContext(db, organizationId);
  return withCompanyContext(base, row?.content);
}

const DRAFT_SECTIONS = [
  "About Exvade (one paragraph: what the company does, stage, lead product)",
  "Programs and products",
  "People and roles (who decides what)",
  "Partners, vendors, sites and investors",
  "Current priorities",
  "Terms and abbreviations",
];

// A first draft built from what Pulse already knows. Returned for a person
// to edit and save -- never saved automatically.
export async function draftCompanyContext(
  db: DbOrTx,
  organizationId: string,
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<string> {
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const [objectiveRows, initiativeRows, projectRows, decisionRows, entityRows, questionRows, ownerRows, recentRows, current] = await Promise.all([
    db
      .select({ title: objectives.title, description: objectives.description, priority: objectives.priority, owner: objectives.owner })
      .from(objectives)
      .where(and(eq(objectives.organizationId, organizationId), ne(objectives.status, "superseded"))),
    db
      .select({ title: initiatives.title, description: initiatives.description })
      .from(initiatives)
      .where(and(eq(initiatives.organizationId, organizationId), ne(initiatives.status, "superseded"))),
    db
      .select({ title: projects.title, description: projects.description, owner: projects.owner })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), inArray(projects.status, ["active", "paused"]))),
    db
      .select({ title: decisions.title, decider: decisions.decider, stakeholders: decisions.stakeholders })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, LIVE_DECISION_STATUSES))),
    db.select({ name: companyEntities.name, kind: companyEntities.kind, notes: companyEntities.notes }).from(companyEntities).where(eq(companyEntities.organizationId, organizationId)),
    db.select({ title: strategicQuestions.title, hypothesis: strategicQuestions.hypothesis }).from(strategicQuestions).where(and(eq(strategicQuestions.organizationId, organizationId), eq(strategicQuestions.status, "open"))),
    db
      .selectDistinct({ owner: tasks.owner })
      .from(tasks)
      .where(and(eq(tasks.organizationId, organizationId), inArray(tasks.status, ["active", "waiting", "needs_attention", "blocked"]))),
    db
      .select({ reasoning: suggestions.reasoning, receivedAt: sources.receivedAt })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .where(and(eq(suggestions.organizationId, organizationId), eq(suggestions.status, "approved"), gte(sources.receivedAt, since)))
      .orderBy(desc(sources.receivedAt))
      .limit(40),
    loadCompanyContext(db, organizationId),
  ]);

  const clip = (text: string | null, n: number) => (text ? (text.length > n ? `${text.slice(0, n)}…` : text) : "");
  const list = (items: string[]) => (items.length ? items.join("\n") : "(none)");
  const prompt = `Draft a short company-context document for Exvade, an internal reference the AI in Exvade Pulse (the company's operations tracker) will read before interpreting every email and meeting. Base it only on the tracker data below. Where the data only hints at something, write it with "(check)" so the team can confirm; never invent facts, names or numbers.

Use these plain-text sections, each a few short bullet points (no markdown headers, just the section name on its own line followed by "- " bullets):
${DRAFT_SECTIONS.map((s) => `- ${s}`).join("\n")}

Keep the whole thing under 5,000 characters.${current ? `\n\nThe team's current version, to improve on rather than discard (keep anything it states that the data doesn't contradict):\n${current.content}` : ""}

Objectives:
${list(objectiveRows.map((o) => `- [${o.priority}] ${o.title}${o.owner ? ` (owner ${o.owner})` : ""}${o.description ? ` — ${clip(o.description, 300)}` : ""}`))}

Initiatives:
${list(initiativeRows.map((i) => `- ${i.title}${i.description ? ` — ${clip(i.description, 200)}` : ""}`))}

Projects:
${list(projectRows.map((p) => `- ${p.title}${p.owner ? ` (owner ${p.owner})` : ""}${p.description ? ` — ${clip(p.description, 200)}` : ""}`))}

Open decisions:
${list(decisionRows.map((d) => `- ${d.title} (decider ${d.decider}${d.stakeholders.length ? `; stakeholders ${d.stakeholders.join(", ")}` : ""})`))}

Strategic questions:
${list(questionRows.map((q) => `- ${q.title}${q.hypothesis ? ` — hypothesis: ${clip(q.hypothesis, 200)}` : ""}`))}

Organizations and people tracked:
${list(entityRows.map((e) => `- ${e.name}${e.kind ? ` (${e.kind})` : ""}${e.notes ? ` — ${clip(e.notes, 150)}` : ""}`))}

Task owners: ${ownerRows.map((o) => o.owner).filter(Boolean).join(", ") || "(none recorded)"}

Recent approved updates (the AI's reasoning, newest first):
${list(recentRows.map((r) => `- ${r.receivedAt.toISOString().slice(0, 10)}: ${clip(r.reasoning, 250)}`))}`;

  const response = await claudeClient.createMessage({
    model: CONTEXT_DRAFT_MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new CompanyContextError("The AI returned an empty draft; try again");
  return text.slice(0, COMPANY_CONTEXT_MAX_CHARS);
}
