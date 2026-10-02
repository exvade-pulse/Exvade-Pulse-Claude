import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { buildExecutiveOverview } from "../reports/executiveOverview.js";
import { HealthError, setObjectiveHealth } from "../objectives/health.js";
import {
  createMilestone,
  createRisk,
  linkMilestone,
  loadOutcomeDetail,
  OverviewError,
  unlinkMilestone,
  updateDecisionForOverview,
  updateMilestone,
  updateOutcome,
  updateRisk,
} from "../overview/manage.js";
import { draftNarrative, publishSnapshot } from "../overview/reporting.js";
import { getContextualClaudeClient } from "../context/companyContext.js";
import { DecisionError } from "../decisions/manage.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = Record<string, unknown>;

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof OverviewError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

// The Executive Overview. GETs are safe for read-only review links;
// requireAuth already refuses every write from one.
export async function overviewRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const actor = (request: { user?: { organizationId: string; userId: string; role: "admin" | "member" } }) => ({
    organizationId: request.user!.organizationId,
    actorId: request.user!.userId,
    role: request.user!.role,
  });

  app.get("/api/overview", async (request, reply) => {
    const { organizationId, role } = request.user!;
    reply.send(await buildExecutiveOverview(db, organizationId, role));
  });

  app.get<{ Params: { id: string } }>("/api/overview/outcomes/:id", async (request, reply) => {
    const detail = await loadOutcomeDetail(db, request.user!.organizationId, request.user!.role, request.params.id);
    if (!detail) return reply.code(404).send({ error: "Outcome not found" });
    reply.send(detail);
  });

  app.put<{ Params: { id: string }; Body: { health?: string; rationale?: string | null; overrideReason?: string | null; reviewBy?: string | null } }>(
    "/api/objectives/:id/health",
    async (request, reply) => {
      const { organizationId, userId, email } = request.user!;
      if (!UUID_RE.test(request.params.id)) return reply.code(404).send({ error: "Objective not found" });
      const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
      try {
        const objective = await setObjectiveHealth(db, {
          organizationId,
          objectiveId: request.params.id,
          actorId: userId,
          actorName: me?.name || email,
          health: String(request.body?.health ?? ""),
          rationale: request.body?.rationale,
          overrideReason: request.body?.overrideReason,
          reviewBy: request.body?.reviewBy,
        });
        reply.send({
          objective: {
            id: objective.id,
            health: objective.health,
            healthRationale: objective.healthRationale,
            healthAssessedAt: objective.healthAssessedAt,
            healthAssessedBy: objective.healthAssessedBy,
          },
        });
      } catch (err) {
        if (err instanceof HealthError) return reply.code(err.message === "Objective not found" ? 404 : 400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Body }>("/api/objectives/:id/overview", async (request, reply) => {
    try {
      reply.send({ objective: await updateOutcome(db, actor(request), request.params.id, request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: Body }>("/api/milestones", async (request, reply) => {
    try {
      reply.code(201).send({ milestone: await createMilestone(db, actor(request), request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Body }>("/api/milestones/:id", async (request, reply) => {
    try {
      reply.send({ milestone: await updateMilestone(db, actor(request), request.params.id, request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: Body }>("/api/milestones/:id/links", async (request, reply) => {
    try {
      await linkMilestone(db, actor(request), request.params.id, request.body ?? {});
      reply.code(201).send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Removes the link only, never the linked record.
  app.delete<{ Params: { id: string; linkId: string } }>("/api/milestones/:id/links/:linkId", async (request, reply) => {
    try {
      await unlinkMilestone(db, actor(request), request.params.id, request.params.linkId);
      reply.send({ ok: true });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Body: Body }>("/api/risks", async (request, reply) => {
    try {
      reply.code(201).send({ risk: await createRisk(db, actor(request), request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Body }>("/api/risks/:id", async (request, reply) => {
    try {
      reply.send({ risk: await updateRisk(db, actor(request), request.params.id, request.body ?? {}) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: Body }>("/api/decisions/:id/overview", async (request, reply) => {
    try {
      const decision = await updateDecisionForOverview(db, actor(request), request.params.id, request.body ?? {});
      reply.send({ decision: { id: decision.id, objectiveId: decision.objectiveId, recommendation: decision.recommendation, impactOfDelay: decision.impactOfDelay } });
    } catch (err) {
      if (err instanceof DecisionError) return reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.message });
      return fail(reply, err);
    }
  });

  // Publishing a reporting period is a leadership act: admin only.
  app.post<{ Body: Body }>("/api/overview/publish", { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const row = await publishSnapshot(db, actor(request), request.body ?? {});
      reply.code(201).send({ publishedAt: row.publishedAt, periodStart: row.periodStart, periodEnd: row.periodEnd });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // A starting draft only; nothing is saved until someone publishes.
  app.post("/api/overview/draft-narrative", { preHandler: requireAdmin }, async (request, reply) => {
    const { organizationId, role } = request.user!;
    try {
      const overview = await buildExecutiveOverview(db, organizationId, role);
      const client = await getContextualClaudeClient(db, organizationId);
      reply.send({ draft: await draftNarrative(overview, client) });
    } catch (err) {
      if (err instanceof OverviewError) return fail(reply, err);
      request.log.error(err);
      reply.code(502).send({ error: "Couldn't get a draft from the AI right now. Try again, or write it yourself." });
    }
  });
}
