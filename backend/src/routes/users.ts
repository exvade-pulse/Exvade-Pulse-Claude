import type { FastifyInstance } from "fastify";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import type { UserRole } from "../db/schema.js";
import { authorizeUser, changeUserRole, listAuthorizedUsers, revokeUser, UserManageError } from "../users/manage.js";

function errorStatus(code: UserManageError["code"]): number {
  switch (code) {
    case "invalid_domain":
      return 400;
    case "self_target":
      return 409;
    case "not_found":
      return 404;
  }
}

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAdmin);

  app.get("/api/users", async (request, reply) => {
    const authorized = await listAuthorizedUsers(db, request.user!.organizationId);
    reply.send({ users: authorized });
  });

  app.post<{ Body: { email?: string; role?: UserRole } }>("/api/users", async (request, reply) => {
    const email = request.body?.email?.trim().toLowerCase();
    const role = request.body?.role ?? "member";
    if (!email) {
      reply.code(400).send({ error: "email is required" });
      return;
    }
    if (role !== "member" && role !== "admin") {
      reply.code(400).send({ error: "role must be 'member' or 'admin'" });
      return;
    }

    try {
      const record = await authorizeUser(db, {
        organizationId: request.user!.organizationId,
        actorId: request.user!.userId,
        email,
        role,
      });
      reply.code(201).send({ user: record });
    } catch (err) {
      if (err instanceof UserManageError) {
        reply.code(errorStatus(err.code)).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.patch<{ Params: { email: string }; Body: { role?: UserRole } }>(
    "/api/users/:email/role",
    async (request, reply) => {
      const role = request.body?.role;
      if (role !== "member" && role !== "admin") {
        reply.code(400).send({ error: "role must be 'member' or 'admin'" });
        return;
      }

      try {
        const updated = await changeUserRole(db, {
          organizationId: request.user!.organizationId,
          actorId: request.user!.userId,
          actorEmail: request.user!.email,
          email: request.params.email,
          role,
        });
        reply.send({ user: updated });
      } catch (err) {
        if (err instanceof UserManageError) {
          reply.code(errorStatus(err.code)).send({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { email: string } }>("/api/users/:email", async (request, reply) => {
    try {
      await revokeUser(db, {
        organizationId: request.user!.organizationId,
        actorId: request.user!.userId,
        actorEmail: request.user!.email,
        email: request.params.email,
      });
      reply.send({ ok: true });
    } catch (err) {
      if (err instanceof UserManageError) {
        reply.code(errorStatus(err.code)).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
