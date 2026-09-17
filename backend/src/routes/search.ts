import type { FastifyInstance } from "fastify";
import { and, eq, ilike, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { decisions, initiatives, objectives, projects, tasks } from "../db/schema.js";
import { taskParentChainQuery } from "../tasks/parentChain.js";
import { visibilityFilter } from "../access/visibility.js";

// Capped per entity type rather than paginated -- this backs a quick
// jump-to-it search, not a browsing view. If any one type routinely fills
// its cap, that's a sign the org wants a dedicated filtered list for it, not
// a bigger search result page.
const RESULTS_PER_TYPE = 8;
// Below this, ILIKE '%x%' across five tables on every keystroke is wasted
// work for a query too short to be meaningfully selective.
const MIN_QUERY_LENGTH = 2;

function anyIlike(pattern: string, ...columns: PgColumn[]): SQL {
  return or(...columns.map((column) => ilike(column, pattern)))!;
}

export async function searchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { q?: string } }>("/api/search", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const q = (request.query.q ?? "").trim();

    if (q.length < MIN_QUERY_LENGTH) {
      reply.send({ objectives: [], initiatives: [], projects: [], tasks: [], decisions: [] });
      return;
    }

    const pattern = `%${q}%`;

    const [objectiveRows, initiativeRows, projectRows, taskRows, decisionRows] = await Promise.all([
      db
        .select({ id: objectives.id, title: objectives.title, status: objectives.status, owner: objectives.owner })
        .from(objectives)
        .where(
          and(
            eq(objectives.organizationId, organizationId),
            anyIlike(pattern, objectives.title, objectives.description),
          ),
        )
        .orderBy(objectives.title)
        .limit(RESULTS_PER_TYPE),
      db
        .select({
          id: initiatives.id,
          title: initiatives.title,
          status: initiatives.status,
          owner: initiatives.owner,
          objective: { id: objectives.id, title: objectives.title },
        })
        .from(initiatives)
        .innerJoin(
          objectives,
          and(eq(objectives.id, initiatives.objectiveId), eq(objectives.organizationId, organizationId)),
        )
        .where(
          and(
            eq(initiatives.organizationId, organizationId),
            anyIlike(pattern, initiatives.title, initiatives.description),
          ),
        )
        .orderBy(initiatives.title)
        .limit(RESULTS_PER_TYPE),
      db
        .select({
          id: projects.id,
          title: projects.title,
          status: projects.status,
          owner: projects.owner,
          initiative: { id: initiatives.id, title: initiatives.title },
        })
        .from(projects)
        .innerJoin(
          initiatives,
          and(eq(initiatives.id, projects.initiativeId), eq(initiatives.organizationId, organizationId)),
        )
        .where(
          and(eq(projects.organizationId, organizationId), anyIlike(pattern, projects.title, projects.description)),
        )
        .orderBy(projects.title)
        .limit(RESULTS_PER_TYPE),
      taskParentChainQuery(
        db,
        organizationId,
        and(
          anyIlike(pattern, tasks.title, tasks.description, tasks.latestUpdate, tasks.nextAction),
          visibilityFilter(request.user!.role, tasks.visibility),
        ),
      )
        .orderBy(tasks.title)
        .limit(RESULTS_PER_TYPE),
      db
        .select({ id: decisions.id, title: decisions.title, status: decisions.status, decider: decisions.decider })
        .from(decisions)
        .where(
          and(
            eq(decisions.organizationId, organizationId),
            anyIlike(
              pattern,
              decisions.title,
              decisions.whyItMatters,
              decisions.relevantContext,
              decisions.suggestedNextStep,
            ),
            visibilityFilter(request.user!.role, decisions.visibility),
          ),
        )
        .orderBy(decisions.title)
        .limit(RESULTS_PER_TYPE),
    ]);

    reply.send({
      objectives: objectiveRows,
      initiatives: initiativeRows,
      projects: projectRows,
      tasks: taskRows,
      decisions: decisionRows,
    });
  });
}
