import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import {
  decisions,
  initiatives,
  LIVE_DECISION_STATUSES,
  objectives,
  projects,
  sources,
  strategicQuestionLinks,
  strategicQuestions,
  suggestions,
  tasks,
  TERMINAL_TASK_STATUSES,
  type QuestionLinkType,
  type UserRole,
} from "../db/schema.js";
import { canViewVisibility, visibilityFilter } from "../access/visibility.js";
import { getContextualClaudeClient } from "../context/companyContext.js";
import { proposeQuestions, type QuestionContext } from "../interpretation/questionDetection.js";
import {
  createQuestion,
  linkToQuestion,
  QuestionError,
  reopenQuestion,
  resolveQuestion,
  unlinkFromQuestion,
  updateQuestion,
} from "../questions/manage.js";
import { UUID_RE } from "./uuid.js";

const LINK_TYPES = ["decision", "task", "project"] as const;

function sendQuestionError(reply: FastifyReply, err: unknown) {
  if (err instanceof QuestionError) {
    reply.code(err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400).send({ error: err.message });
    return true;
  }
  return false;
}

export interface QuestionLinkView {
  type: QuestionLinkType;
  id: string;
  title: string;
  status: string;
}

// Every question with its linked records resolved to titles/status. A
// linked task or decision the caller can't see is left out.
export async function loadQuestions(organizationId: string, role: UserRole) {
  const [questionRows, linkRows, objectiveRows] = await Promise.all([
    db.select().from(strategicQuestions).where(eq(strategicQuestions.organizationId, organizationId)).orderBy(asc(strategicQuestions.createdAt)),
    db.select().from(strategicQuestionLinks).where(eq(strategicQuestionLinks.organizationId, organizationId)),
    db.select({ id: objectives.id, title: objectives.title }).from(objectives).where(eq(objectives.organizationId, organizationId)),
  ]);
  const idsOf = (type: QuestionLinkType) => [...new Set(linkRows.filter((l) => l.entityType === type).map((l) => l.entityId))];
  const [decisionRows, taskRows, projectRows] = await Promise.all([
    idsOf("decision").length
      ? db
          .select({ id: decisions.id, title: decisions.title, status: decisions.status, visibility: decisions.visibility })
          .from(decisions)
          .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.id, idsOf("decision"))))
      : [],
    idsOf("task").length
      ? db
          .select({ id: tasks.id, title: tasks.title, status: tasks.status, visibility: tasks.visibility })
          .from(tasks)
          .where(and(eq(tasks.organizationId, organizationId), inArray(tasks.id, idsOf("task"))))
      : [],
    idsOf("project").length
      ? db
          .select({ id: projects.id, title: projects.title, status: projects.status })
          .from(projects)
          .where(and(eq(projects.organizationId, organizationId), inArray(projects.id, idsOf("project"))))
      : [],
  ]);
  const found = new Map<string, QuestionLinkView>();
  for (const d of decisionRows) if (canViewVisibility(role, d.visibility)) found.set(`decision:${d.id}`, { type: "decision", id: d.id, title: d.title, status: d.status });
  for (const t of taskRows) if (canViewVisibility(role, t.visibility)) found.set(`task:${t.id}`, { type: "task", id: t.id, title: t.title, status: t.status });
  for (const p of projectRows) found.set(`project:${p.id}`, { type: "project", id: p.id, title: p.title, status: p.status });
  const objectiveTitle = new Map(objectiveRows.map((o) => [o.id, o.title]));

  return questionRows.map((q) => ({
    ...q,
    objective: objectiveTitle.get(q.objectiveId) ?? "(unknown objective)",
    links: linkRows
      .filter((l) => l.questionId === q.id)
      .map((l) => found.get(`${l.entityType}:${l.entityId}`))
      .filter((l): l is QuestionLinkView => !!l),
  }));
}

// The live records a question can be linked to, for the picker.
async function loadLinkable(organizationId: string, role: UserRole) {
  const [decisionRows, taskRows, projectRows, objectiveRows] = await Promise.all([
    db
      .select({ id: decisions.id, title: decisions.title, status: decisions.status })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, LIVE_DECISION_STATUSES), visibilityFilter(role, decisions.visibility)))
      .orderBy(asc(decisions.title)),
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, project: projects.title })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          inArray(tasks.status, ["active", "waiting", "needs_attention", "blocked"]),
          visibilityFilter(role, tasks.visibility),
        ),
      )
      .orderBy(asc(tasks.title)),
    db
      .select({ id: projects.id, title: projects.title, status: projects.status })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), inArray(projects.status, ["active", "paused"])))
      .orderBy(asc(projects.title)),
    db
      .select({ id: objectives.id, title: objectives.title })
      .from(objectives)
      .where(and(eq(objectives.organizationId, organizationId), ne(objectives.status, "superseded")))
      .orderBy(asc(objectives.title)),
  ]);
  return { decisions: decisionRows, tasks: taskRows, projects: projectRows, objectives: objectiveRows };
}

// What the AI first pass sees: the whole company, as the admin view.
async function loadQuestionContext(organizationId: string): Promise<QuestionContext> {
  const [objectiveRows, initiativeRows, projectRows, decisionRows, taskRows, existing, pending] = await Promise.all([
    db
      .select({ id: objectives.id, title: objectives.title, description: objectives.description })
      .from(objectives)
      .where(and(eq(objectives.organizationId, organizationId), inArray(objectives.status, ["active", "paused"]))),
    db.select({ id: initiatives.id, objectiveId: initiatives.objectiveId }).from(initiatives).where(eq(initiatives.organizationId, organizationId)),
    db
      .select({ id: projects.id, title: projects.title, initiativeId: projects.initiativeId })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), inArray(projects.status, ["active", "paused"]))),
    db
      .select({ id: decisions.id, title: decisions.title, whyItMatters: decisions.whyItMatters, decider: decisions.decider, status: decisions.status })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), inArray(decisions.status, LIVE_DECISION_STATUSES))),
    db
      .select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId, status: tasks.status, nextAction: tasks.nextAction })
      .from(tasks)
      .where(and(eq(tasks.organizationId, organizationId), inArray(tasks.status, ["active", "waiting", "needs_attention", "blocked"]))),
    db
      .select({ title: strategicQuestions.title, objectiveId: strategicQuestions.objectiveId })
      .from(strategicQuestions)
      .where(eq(strategicQuestions.organizationId, organizationId)),
    db
      .select({ proposedDiff: suggestions.proposedDiff })
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, organizationId), eq(suggestions.changeType, "question"), inArray(suggestions.status, ["pending", "edited"]))),
  ]);
  const objectiveTitle = new Map(objectiveRows.map((o) => [o.id, o.title]));
  const objectiveOfInitiative = new Map(initiativeRows.map((i) => [i.id, i.objectiveId]));
  const projectTitle = new Map(projectRows.map((p) => [p.id, p.title]));
  const pendingQuestions = pending.map((p) => p.proposedDiff as { title?: string; objectiveId?: string });
  return {
    objectives: objectiveRows,
    decisions: decisionRows,
    projects: projectRows.map((p) => ({ id: p.id, title: p.title, objective: objectiveTitle.get(objectiveOfInitiative.get(p.initiativeId) ?? "") ?? "(other)" })),
    tasks: taskRows
      .filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status))
      .map((t) => ({ id: t.id, title: t.title, project: projectTitle.get(t.projectId) ?? "(other)", status: t.status, nextAction: t.nextAction })),
    existingQuestions: [
      ...existing.map((q) => ({ title: q.title, objective: objectiveTitle.get(q.objectiveId) ?? "" })),
      ...pendingQuestions.filter((q) => typeof q.title === "string").map((q) => ({ title: q.title!, objective: objectiveTitle.get(q.objectiveId ?? "") ?? "" })),
    ],
  };
}

const createBody = z.object({
  objectiveId: z.string().uuid(),
  title: z.string().min(1),
  hypothesis: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
});
const updateBody = z.object({
  objectiveId: z.string().uuid().optional(),
  title: z.string().min(1).optional(),
  hypothesis: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
});
const linkBody = z.object({ entityType: z.enum(LINK_TYPES), entityId: z.string().uuid() });

export async function questionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/questions", async (request, reply) => {
    const { organizationId, role } = request.user!;
    const [questions, linkable] = await Promise.all([loadQuestions(organizationId, role), loadLinkable(organizationId, role)]);
    reply.send({ questions, linkable });
  });

  app.post("/api/questions", async (request, reply) => {
    const body = createBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "objectiveId and title are required" });
    try {
      const question = await createQuestion(db, { organizationId: request.user!.organizationId, actorId: request.user!.userId, ...body.data });
      reply.code(201).send({ question });
    } catch (err) {
      if (!sendQuestionError(reply, err)) throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/questions/:id", async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(404).send({ error: "Question not found" });
    const body = updateBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid fields" });
    try {
      const question = await updateQuestion(db, {
        organizationId: request.user!.organizationId,
        actorId: request.user!.userId,
        questionId: request.params.id,
        fields: body.data,
      });
      reply.send({ question });
    } catch (err) {
      if (!sendQuestionError(reply, err)) throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/questions/:id/resolve", async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(404).send({ error: "Question not found" });
    const body = z.object({ resolution: z.string() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "resolution is required" });
    try {
      const result = await db.transaction((tx) =>
        resolveQuestion(tx, {
          organizationId: request.user!.organizationId,
          actorId: request.user!.userId,
          questionId: request.params.id,
          resolution: body.data.resolution,
        }),
      );
      const role = request.user!.role;
      reply.send({
        question: result.question,
        openDecisions: result.openDecisions.filter((d) => canViewVisibility(role, d.visibility)).map(({ id, title, status }) => ({ id, title, status })),
      });
    } catch (err) {
      if (!sendQuestionError(reply, err)) throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/questions/:id/reopen", async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(404).send({ error: "Question not found" });
    try {
      const question = await reopenQuestion(db, { organizationId: request.user!.organizationId, actorId: request.user!.userId, questionId: request.params.id });
      reply.send({ question });
    } catch (err) {
      if (!sendQuestionError(reply, err)) throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/questions/:id/links", async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(404).send({ error: "Question not found" });
    const body = linkBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "entityType and entityId are required" });
    const { organizationId, role, userId } = request.user!;
    // A member can't link (and so reveal the title of) a record they can't see.
    if (body.data.entityType !== "project" && role !== "admin") {
      const table = body.data.entityType === "decision" ? decisions : tasks;
      const [row] = await db.select({ visibility: table.visibility }).from(table).where(and(eq(table.id, body.data.entityId), eq(table.organizationId, organizationId)));
      if (row && !canViewVisibility(role, row.visibility)) return reply.code(404).send({ error: `That ${body.data.entityType} wasn't found` });
    }
    try {
      await linkToQuestion(db, { organizationId, actorId: userId, questionId: request.params.id, ...body.data });
      reply.code(201).send({ ok: true });
    } catch (err) {
      if (!sendQuestionError(reply, err)) throw err;
    }
  });

  app.delete<{ Params: { id: string; entityType: string; entityId: string } }>(
    "/api/questions/:id/links/:entityType/:entityId",
    async (request, reply) => {
      const { id, entityType, entityId } = request.params;
      if (!UUID_RE.test(id) || !UUID_RE.test(entityId) || !(LINK_TYPES as readonly string[]).includes(entityType)) {
        return reply.code(404).send({ error: "Link not found" });
      }
      try {
        await unlinkFromQuestion(db, { organizationId: request.user!.organizationId, questionId: id, entityType: entityType as QuestionLinkType, entityId });
        reply.send({ ok: true });
      } catch (err) {
        if (!sendQuestionError(reply, err)) throw err;
      }
    },
  );

  // On demand: one Claude call proposes strategic questions (and
  // conversions of over-broad decisions). Each becomes a "question"
  // suggestion in Review; nothing is created until a person approves it.
  app.post("/api/questions/suggest", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const context = await loadQuestionContext(organizationId);
    const proposals = await proposeQuestions(context, await getContextualClaudeClient(db, organizationId));
    if (proposals.length > 0) {
      const [source] = await db
        .insert(sources)
        .values({
          organizationId,
          type: "manual",
          externalId: randomUUID(),
          receivedAt: new Date(),
          rawBody: `Automated strategic-question pass across ${context.objectives.length} objective(s), ${context.decisions.length} open decision(s) and ${context.tasks.length} open task(s).`,
        })
        .returning();
      await db.insert(suggestions).values(
        proposals.map(({ reasoning, confidence, ...proposal }) => ({
          organizationId,
          sourceId: source.id,
          targetType: "question" as const,
          targetId: null,
          changeType: "question" as const,
          proposedDiff: proposal,
          reasoning,
          confidence,
        })),
      );
    }
    reply.send({
      objectivesChecked: context.objectives.length,
      questionsProposed: proposals.length,
      conversionsProposed: proposals.filter((p) => p.convertDecisionId).length,
    });
  });
}
