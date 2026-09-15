import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { SESSION_COOKIE_NAME, verifySession, type SessionClaims } from "./jwt.js";
import { db } from "../db/client.js";
import { authorizedUsers } from "../db/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionClaims;
  }
}

// Verifies the JWT, then re-reads the caller's authorization from
// authorized_users on every request. The JWT-embedded role is only a hint for
// the UI -- this DB lookup is the actual security boundary, so a revoked or
// demoted person's existing session dies (or loses privilege) immediately
// rather than lingering for up to 7 days.
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  const claims = token ? await verifySession(token) : null;

  if (!claims) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }

  const [authorization] = await db
    .select()
    .from(authorizedUsers)
    .where(and(eq(authorizedUsers.organizationId, claims.organizationId), eq(authorizedUsers.email, claims.email)));

  if (!authorization) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }

  request.user = { ...claims, role: authorization.role };
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user?.role !== "admin") {
    reply.code(403).send({ error: "Admin access required" });
    return;
  }
}
