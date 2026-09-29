import { and, eq, inArray, ne } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import {
  auditLog,
  decisions,
  LIVE_DECISION_STATUSES,
  objectives,
  projects,
  strategicQuestionLinks,
  strategicQuestions,
  tasks,
  type QuestionLinkType,
} from "../db/schema.js";
import { createDecision } from "../decisions/manage.js";

export class QuestionError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "conflict" | "invalid",
  ) {
    super(message);
  }
}

const LINK_TABLE = { decision: decisions, task: tasks, project: projects } as const;

async function requireObjective(db: DbOrTx, organizationId: string, objectiveId: string) {
  const [objective] = await db
    .select({ id: objectives.id })
    .from(objectives)
    .where(and(eq(objectives.id, objectiveId), eq(objectives.organizationId, organizationId), ne(objectives.status, "superseded")));
  if (!objective) throw new QuestionError("Objective not found", "not_found");
}

async function requireQuestion(db: DbOrTx, organizationId: string, questionId: string) {
  const [question] = await db
    .select()
    .from(strategicQuestions)
    .where(and(eq(strategicQuestions.id, questionId), eq(strategicQuestions.organizationId, organizationId)));
  if (!question) throw new QuestionError("Question not found", "not_found");
  return question;
}

function clean(text: string | null | undefined) {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

export async function createQuestion(
  db: DbOrTx,
  params: {
    organizationId: string;
    actorId: string;
    objectiveId: string;
    title: string;
    hypothesis?: string | null;
    owner?: string | null;
    convertedFromDecisionId?: string | null;
  },
) {
  const title = params.title.trim();
  if (!title) throw new QuestionError("A question needs a title", "invalid");
  await requireObjective(db, params.organizationId, params.objectiveId);
  const [question] = await db
    .insert(strategicQuestions)
    .values({
      organizationId: params.organizationId,
      objectiveId: params.objectiveId,
      title,
      hypothesis: clean(params.hypothesis),
      owner: clean(params.owner),
      convertedFromDecisionId: params.convertedFromDecisionId ?? null,
    })
    .returning();
  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "question.created",
    entityType: "question",
    entityId: question.id,
    details: { title },
  });
  return question;
}

export async function updateQuestion(
  db: DbOrTx,
  params: {
    organizationId: string;
    actorId: string;
    questionId: string;
    fields: { title?: string; hypothesis?: string | null; owner?: string | null; objectiveId?: string };
  },
) {
  await requireQuestion(db, params.organizationId, params.questionId);
  const set: Partial<typeof strategicQuestions.$inferInsert> = { updatedAt: new Date() };
  if (params.fields.title !== undefined) {
    const title = params.fields.title.trim();
    if (!title) throw new QuestionError("A question needs a title", "invalid");
    set.title = title;
  }
  if (params.fields.hypothesis !== undefined) set.hypothesis = clean(params.fields.hypothesis);
  if (params.fields.owner !== undefined) set.owner = clean(params.fields.owner);
  if (params.fields.objectiveId !== undefined) {
    await requireObjective(db, params.organizationId, params.fields.objectiveId);
    set.objectiveId = params.fields.objectiveId;
  }
  const [updated] = await db.update(strategicQuestions).set(set).where(eq(strategicQuestions.id, params.questionId)).returning();
  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "question.updated",
    entityType: "question",
    entityId: params.questionId,
    details: { fields: Object.keys(params.fields) },
  });
  return updated;
}

// Records the answer. Deliberately does NOT close the question's open
// decisions -- it returns them so the person can close each one themselves.
export async function resolveQuestion(
  db: DbOrTx,
  params: { organizationId: string; actorId: string; questionId: string; resolution: string },
) {
  const question = await requireQuestion(db, params.organizationId, params.questionId);
  if (question.status === "resolved") throw new QuestionError("Question is already resolved", "conflict");
  const resolution = params.resolution.trim();
  if (!resolution) throw new QuestionError("Resolving a question needs the answer", "invalid");
  const now = new Date();
  const [updated] = await db
    .update(strategicQuestions)
    .set({ status: "resolved", resolution, resolvedAt: now, updatedAt: now })
    .where(eq(strategicQuestions.id, question.id))
    .returning();
  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "question.resolved",
    entityType: "question",
    entityId: question.id,
    details: { resolution },
  });
  return { question: updated, openDecisions: await openDecisionsOf(db, params.organizationId, question.id) };
}

export async function reopenQuestion(db: DbOrTx, params: { organizationId: string; actorId: string; questionId: string }) {
  const question = await requireQuestion(db, params.organizationId, params.questionId);
  if (question.status !== "resolved") throw new QuestionError("Question is already open", "conflict");
  const [updated] = await db
    .update(strategicQuestions)
    .set({ status: "open", resolvedAt: null, updatedAt: new Date() })
    .where(eq(strategicQuestions.id, question.id))
    .returning();
  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "question.reopened",
    entityType: "question",
    entityId: question.id,
    details: {},
  });
  return updated;
}

export async function openDecisionsOf(db: DbOrTx, organizationId: string, questionId: string) {
  const links = await db
    .select({ entityId: strategicQuestionLinks.entityId })
    .from(strategicQuestionLinks)
    .where(
      and(
        eq(strategicQuestionLinks.organizationId, organizationId),
        eq(strategicQuestionLinks.questionId, questionId),
        eq(strategicQuestionLinks.entityType, "decision"),
      ),
    );
  if (links.length === 0) return [];
  return db
    .select({ id: decisions.id, title: decisions.title, status: decisions.status, visibility: decisions.visibility })
    .from(decisions)
    .where(
      and(
        eq(decisions.organizationId, organizationId),
        inArray(
          decisions.id,
          links.map((l) => l.entityId),
        ),
        inArray(decisions.status, LIVE_DECISION_STATUSES),
      ),
    );
}

export async function linkToQuestion(
  db: DbOrTx,
  params: { organizationId: string; actorId: string; questionId: string; entityType: QuestionLinkType; entityId: string },
) {
  await requireQuestion(db, params.organizationId, params.questionId);
  const table = LINK_TABLE[params.entityType] as typeof tasks;
  const [entity] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, params.entityId), eq(table.organizationId, params.organizationId)));
  if (!entity) throw new QuestionError(`That ${params.entityType} wasn't found`, "not_found");
  const [link] = await db
    .insert(strategicQuestionLinks)
    .values({
      organizationId: params.organizationId,
      questionId: params.questionId,
      entityType: params.entityType,
      entityId: params.entityId,
      createdBy: params.actorId,
    })
    .onConflictDoNothing()
    .returning();
  return link ?? null;
}

export async function unlinkFromQuestion(
  db: DbOrTx,
  params: { organizationId: string; questionId: string; entityType: QuestionLinkType; entityId: string },
) {
  const removed = await db
    .delete(strategicQuestionLinks)
    .where(
      and(
        eq(strategicQuestionLinks.organizationId, params.organizationId),
        eq(strategicQuestionLinks.questionId, params.questionId),
        eq(strategicQuestionLinks.entityType, params.entityType),
        eq(strategicQuestionLinks.entityId, params.entityId),
      ),
    )
    .returning({ id: strategicQuestionLinks.id });
  if (removed.length === 0) throw new QuestionError("Link not found", "not_found");
}

// What an AI "question" suggestion carries (see questionDetection.ts).
export interface QuestionProposal {
  objectiveId: string;
  title: string;
  hypothesis: string | null;
  decisionIds: string[];
  taskIds: string[];
  projectIds: string[];
  // Optional: a broad decision this question replaces, and the smaller
  // decisions to create under the question in its place.
  convertDecisionId: string | null;
  newDecisions: Array<{ title: string; decider: string | null }>;
}

// Applies an approved "question" suggestion in one transaction: creates the
// question, creates any smaller decisions, links everything, and -- for a
// conversion -- marks the broad decision superseded with a note pointing at
// the question (kept and linked, never deleted).
export async function applyQuestionProposal(
  tx: DbOrTx,
  params: { organizationId: string; actorId: string; sourceId: string; proposal: QuestionProposal },
) {
  const { organizationId, actorId, proposal } = params;
  let converted: typeof decisions.$inferSelect | undefined;
  if (proposal.convertDecisionId) {
    [converted] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, proposal.convertDecisionId), eq(decisions.organizationId, organizationId)));
    if (!converted) throw new QuestionError("The decision to convert wasn't found", "not_found");
    if (!LIVE_DECISION_STATUSES.includes(converted.status)) {
      throw new QuestionError(`The decision to convert is already ${converted.status}`, "conflict");
    }
  }

  const question = await createQuestion(tx, {
    organizationId,
    actorId,
    objectiveId: proposal.objectiveId,
    title: proposal.title,
    hypothesis: proposal.hypothesis,
    convertedFromDecisionId: converted?.id ?? null,
  });

  const created: string[] = [];
  for (const d of proposal.newDecisions) {
    const decision = await createDecision(tx, {
      organizationId,
      actorId,
      title: d.title,
      whyItMatters: `Part of the strategic question: ${question.title}`,
      relevantContext: null,
      suggestedNextStep: null,
      decider: d.decider?.trim() || converted?.decider || "Leadership",
      stakeholders: converted?.stakeholders ?? [],
      dueDate: null,
      relatedTaskId: null,
      sourceId: params.sourceId,
    });
    created.push(decision.id);
  }

  const links: Array<{ entityType: QuestionLinkType; entityId: string }> = [
    ...[...proposal.decisionIds, ...created, ...(converted ? [converted.id] : [])].map((id) => ({ entityType: "decision" as const, entityId: id })),
    ...proposal.taskIds.map((id) => ({ entityType: "task" as const, entityId: id })),
    ...proposal.projectIds.map((id) => ({ entityType: "project" as const, entityId: id })),
  ];
  for (const link of links) {
    // A record deleted or moved since the proposal is skipped, not fatal.
    try {
      await linkToQuestion(tx, { organizationId, actorId, questionId: question.id, ...link });
    } catch (err) {
      if (!(err instanceof QuestionError)) throw err;
    }
  }

  if (converted) {
    const entry = `[${new Date().toISOString().slice(0, 10)} — converted] Became the strategic question "${question.title}".`;
    await tx
      .update(decisions)
      .set({ status: "superseded", resolution: converted.resolution ? `${converted.resolution}\n\n${entry}` : entry, updatedAt: new Date() })
      .where(eq(decisions.id, converted.id));
    await tx.insert(auditLog).values({
      organizationId,
      actorId,
      action: "decision.converted_to_question",
      entityType: "decision",
      entityId: converted.id,
      details: { questionId: question.id, previousStatus: converted.status },
    });
  }

  return { question, createdDecisionIds: created };
}
