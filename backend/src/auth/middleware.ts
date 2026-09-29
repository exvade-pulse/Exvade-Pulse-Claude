import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { SESSION_COOKIE_NAME, verifySession, type SessionClaims } from "./jwt.js";
import { db } from "../db/client.js";
import { authorizedUsers } from "../db/schema.js";
import { activeViewLink } from "../viewLinks/manage.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionClaims;
  }
}

// Areas a view-only session never sees, even read-only: who has access,
// connected accounts and keys, and the view links themselves.
const VIEW_ONLY_BLOCKED_PREFIXES = ["/api/users", "/api/integrations", "/auth/gmail", "/api/view-links"];

// Verifies the JWT, then re-reads the caller's authorization from
// authorized_users on every request. The JWT-embedded role is only a hint for
// the UI -- this DB lookup is the actual security boundary, so a revoked or
// demoted person's existing session dies (or loses privilege) immediately
// rather than lingering for up to 7 days.
//
// A view-only link session is re-checked against its view_links row instead
// (revoked or expired: out immediately), and is refused anything but reading.
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  const claims = token ? await verifySession(token) : null;

  if (!claims) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }

  if (claims.viewLinkId) {
    const link = await activeViewLink(db, claims.viewLinkId, claims.organizationId);
    if (!link) {
      reply.code(401).send({ error: "This view-only link has expired or been switched off" });
      return;
    }
    const path = request.url.split("?")[0];
    if ((request.method !== "GET" && request.method !== "HEAD") || VIEW_ONLY_BLOCKED_PREFIXES.some((p) => path.startsWith(p))) {
      reply.code(403).send({ error: "This is a read-only view: changes are disabled" });
      return;
    }
    request.user = {
      userId: link.createdBy,
      organizationId: link.organizationId,
      email: "view-only",
      role: link.includeRestricted ? "admin" : "member",
      viewLinkId: link.id,
      readOnly: true,
    };
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

// A view-only session never passes, whatever its visibility level.
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user?.role !== "admin" || request.user.readOnly) {
    reply.code(403).send({ error: "Admin access required" });
    return;
  }
}
