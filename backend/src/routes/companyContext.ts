import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import {
  COMPANY_CONTEXT_MAX_CHARS,
  CompanyContextError,
  draftCompanyContext,
  loadCompanyContext,
  saveCompanyContext,
} from "../context/companyContext.js";

export async function companyContextRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Everyone can read it; it's what the AI is told about the company.
  app.get("/api/company-context", async (request, reply) => {
    const row = await loadCompanyContext(db, request.user!.organizationId);
    let updatedByName: string | null = null;
    if (row?.updatedBy) {
      const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.updatedBy));
      updatedByName = user?.name ?? user?.email ?? null;
    }
    reply.send({
      content: row?.content ?? "",
      updatedAt: row?.updatedAt ?? null,
      updatedBy: updatedByName,
      maxChars: COMPANY_CONTEXT_MAX_CHARS,
    });
  });

  // Admins only: it steers every AI suggestion.
  app.put("/api/company-context", { preHandler: requireAdmin }, async (request, reply) => {
    const body = z.object({ content: z.string() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "content is required" });
    try {
      const saved = await saveCompanyContext(db, {
        organizationId: request.user!.organizationId,
        actorId: request.user!.userId,
        content: body.data.content,
      });
      reply.send({ content: saved.content, updatedAt: saved.updatedAt });
    } catch (err) {
      if (err instanceof CompanyContextError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // A draft from what Pulse already knows, for an admin to edit and save.
  app.post("/api/company-context/draft", { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const draft = await draftCompanyContext(db, request.user!.organizationId);
      reply.send({ draft });
    } catch (err) {
      if (err instanceof CompanyContextError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });
}
