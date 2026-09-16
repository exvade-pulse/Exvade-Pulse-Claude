import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { auditLog, users } from "../db/schema.js";

// No pagination yet -- a flat "most recent N" is enough for a first pass at
// making the audit log visible at all; revisit if 100 stops being enough.
const RECENT_LIMIT = 100;

export async function activityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/activity", async (request, reply) => {
    const organizationId = request.user!.organizationId;

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

    reply.send({ entries: rows });
  });
}
