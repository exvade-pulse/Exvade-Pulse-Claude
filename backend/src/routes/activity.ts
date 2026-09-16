import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { auditLog, decisions, users } from "../db/schema.js";

// No pagination yet -- a flat "most recent N" is enough for a first pass at
// making the audit log visible at all; revisit if 100 stops being enough.
const RECENT_LIMIT = 100;

export async function activityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/activity", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const userId = request.user!.userId;

    const [caller] = await db.select({ lastActivityViewAt: users.lastActivityViewAt }).from(users).where(eq(users.id, userId));
    // Captured before this request's own write below updates it -- this is
    // "since the visit before this one", not "since a moment ago". A null
    // here means the user has never visited before; treat that as "no prior
    // visit to scope from" rather than a since-forever/since-epoch query.
    const previousLastActivityViewAt = caller?.lastActivityViewAt ?? null;
    // On a first-ever visit, scope "since last visit" to today rather than
    // the org's entire history, so a brand-new user doesn't get a summary
    // reporting on months of activity that predates them looking at all.
    const sinceCutoff = previousLastActivityViewAt ?? new Date(new Date().setHours(0, 0, 0, 0));

    const rows = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        details: auditLog.details,
        createdAt: auditLog.createdAt,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(eq(auditLog.organizationId, organizationId))
      .orderBy(desc(auditLog.createdAt))
      .limit(RECENT_LIMIT);

    const sinceLastVisit = await db
      .select({ action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.organizationId, organizationId),
          gt(auditLog.createdAt, sinceCutoff),
        ),
      );

    let statusMoves = 0;
    let completions = 0;
    for (const entry of sinceLastVisit) {
      if (entry.action !== "suggestion.approved") continue;
      const appliedFields = (entry.details as { appliedFields?: Record<string, unknown> } | null)?.appliedFields;
      if (!appliedFields || !("status" in appliedFields)) continue;
      statusMoves += 1;
      if (appliedFields.status === "completed" || appliedFields.status === "resolved") {
        completions += 1;
      }
    }

    const newDecisions = sinceLastVisit.filter((entry) => entry.action === "decision.created").length;

    // Present-tense, not time-scoped -- "how many still need a call right
    // now" -- and ordered the same way GET /api/decisions already does
    // (soonest due date first, no-due-date last), so "most urgent" means the
    // same thing here as it does everywhere else in the app.
    const openDecisions = await db
      .select({ id: decisions.id, title: decisions.title })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), eq(decisions.status, "open")))
      .orderBy(sql`${decisions.dueDate} is null`, decisions.dueDate);

    reply.send({
      entries: rows,
      previousLastActivityViewAt: previousLastActivityViewAt ? previousLastActivityViewAt.toISOString() : null,
      summary: {
        statusMoves,
        completions,
        newDecisions,
        openDecisionsCount: openDecisions.length,
        mostUrgentOpenDecision: openDecisions[0] ? { id: openDecisions[0].id, title: openDecisions[0].title } : null,
      },
    });
  });

  // Deliberately a separate mutation from the GET above: a read must stay a
  // read, or two open tabs (or a refresh, or any future polling) would each
  // silently consume the "since last visit" window before the user actually
  // saw it. The frontend calls this once per genuine page visit, not once
  // per fetch.
  app.post("/api/activity/mark-visited", async (request, reply) => {
    await db
      .update(users)
      .set({ lastActivityViewAt: new Date() })
      .where(eq(users.id, request.user!.userId));
    reply.send({ ok: true });
  });
}
