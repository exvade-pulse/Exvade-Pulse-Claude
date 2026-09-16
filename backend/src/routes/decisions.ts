import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { decisions, tasks } from "../db/schema.js";
import { addDecisionInfo, assignDecision, createDecision, resolveDecision, DecisionError } from "../decisions/manage.js";

export async function decisionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { status?: string } }>("/api/decisions", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    // No status query param means "still needs a decision" -- decided ones fall
    // out of the working list by default, same default-to-active-work pattern
    // as suggestions.ts.
    const status = request.query.status ?? "open";

    const rows = await db
      .select({
        id: decisions.id,
        title: decisions.title,
        whyItMatters: decisions.whyItMatters,
        relevantContext: decisions.relevantContext,
        suggestedNextStep: decisions.suggestedNextStep,
        decider: decisions.decider,
        stakeholders: decisions.stakeholders,
        status: decisions.status,
        dueDate: decisions.dueDate,
        resolution: decisions.resolution,
        decidedAt: decisions.decidedAt,
        relatedTaskId: decisions.relatedTaskId,
        relatedTaskTitle: tasks.title,
        // Lets the resolve UI decide whether "also unblock this task" is even
        // a relevant option to show, without a second round trip per decision.
        relatedTaskStatus: tasks.status,
        sourceId: decisions.sourceId,
        createdAt: decisions.createdAt,
        updatedAt: decisions.updatedAt,
      })
      .from(decisions)
      .leftJoin(tasks, eq(tasks.id, decisions.relatedTaskId))
      .where(and(eq(decisions.organizationId, organizationId), eq(decisions.status, status as never)))
      // Soonest due date first; decisions with no due date sort last, not first.
      .orderBy(sql`${decisions.dueDate} is null`, decisions.dueDate);

    reply.send({ decisions: rows });
  });

  app.post<{
    Body: {
      title?: string;
      whyItMatters?: string | null;
      relevantContext?: string | null;
      suggestedNextStep?: string | null;
      decider?: string;
      stakeholders?: string[];
      dueDate?: string | null;
      relatedTaskId?: string | null;
      sourceId?: string | null;
    };
  }>("/api/decisions", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.title || !body.title.trim()) {
      reply.code(400).send({ error: "title is required" });
      return;
    }
    if (!body.decider || !body.decider.trim()) {
      reply.code(400).send({ error: "decider is required" });
      return;
    }

    try {
      const decision = await createDecision(db, {
        organizationId: request.user!.organizationId,
        actorId: request.user!.userId,
        title: body.title,
        whyItMatters: body.whyItMatters ?? null,
        relevantContext: body.relevantContext ?? null,
        suggestedNextStep: body.suggestedNextStep ?? null,
        decider: body.decider,
        stakeholders: Array.isArray(body.stakeholders) ? body.stakeholders : [],
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        relatedTaskId: body.relatedTaskId ?? null,
        sourceId: body.sourceId ?? null,
      });
      reply.code(201).send({ decision });
    } catch (err) {
      if (err instanceof DecisionError) {
        reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: { note?: string } }>(
    "/api/decisions/:id/add-info",
    async (request, reply) => {
      const note = request.body?.note?.trim();
      if (!note) {
        reply.code(400).send({ error: "note is required" });
        return;
      }

      try {
        const decision = await addDecisionInfo(db, {
          organizationId: request.user!.organizationId,
          decisionId: request.params.id,
          actorId: request.user!.userId,
          actorLabel: request.user!.email,
          note,
        });
        reply.send({ decision });
      } catch (err) {
        if (err instanceof DecisionError) {
          reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { decider?: string } }>(
    "/api/decisions/:id/assign",
    async (request, reply) => {
      const decider = request.body?.decider?.trim();
      if (!decider) {
        reply.code(400).send({ error: "decider is required" });
        return;
      }

      try {
        const decision = await assignDecision(db, {
          organizationId: request.user!.organizationId,
          decisionId: request.params.id,
          actorId: request.user!.userId,
          decider,
        });
        reply.send({ decision });
      } catch (err) {
        if (err instanceof DecisionError) {
          reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { resolution?: string; alsoUnblockTask?: boolean } }>(
    "/api/decisions/:id/resolve",
    async (request, reply) => {
      const resolution = request.body?.resolution;
      if (!resolution || !resolution.trim()) {
        reply.code(400).send({ error: "resolution is required" });
        return;
      }

      try {
        const { decision, unblockedTask } = await resolveDecision(db, {
          organizationId: request.user!.organizationId,
          decisionId: request.params.id,
          actorId: request.user!.userId,
          resolution,
          alsoUnblockTask: request.body?.alsoUnblockTask ?? false,
        });
        reply.send({ decision, unblockedTask });
      } catch (err) {
        if (err instanceof DecisionError) {
          reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );
}
