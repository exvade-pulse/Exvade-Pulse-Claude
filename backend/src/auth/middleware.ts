import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME, verifySession, type SessionClaims } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionClaims;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  const claims = token ? await verifySession(token) : null;

  if (!claims) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }

  request.user = claims;
}
