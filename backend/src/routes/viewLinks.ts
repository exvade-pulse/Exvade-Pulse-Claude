import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { createViewLink, listViewLinks, revokeViewLink, unlockViewLink, VIEW_LINK_DAYS, ViewLinkError } from "../viewLinks/manage.js";
import { UUID_RE } from "./uuid.js";

const createBody = z.object({
  label: z.string().max(100).nullable().optional(),
  days: z.union([z.literal(VIEW_LINK_DAYS[0]), z.literal(VIEW_LINK_DAYS[1]), z.literal(VIEW_LINK_DAYS[2])]),
  includeRestricted: z.boolean(),
});

export async function viewLinkRoutes(app: FastifyInstance) {
  // Admin management. requireAdmin also refuses view-only sessions.
  app.get("/api/view-links", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    reply.send({ links: await listViewLinks(db, request.user!.organizationId) });
  });

  app.post("/api/view-links", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const body = createBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Choose 1, 7 or 30 days" });
    const { link, token, password } = await createViewLink(db, {
      organizationId: request.user!.organizationId,
      actorId: request.user!.userId,
      label: body.data.label ?? null,
      days: body.data.days,
      includeRestricted: body.data.includeRestricted,
    });
    reply.code(201).send({
      id: link.id,
      url: `${config.frontendUrl.replace(/\/$/, "")}/view?t=${token}`,
      password,
      expiresAt: link.expiresAt,
    });
  });

  app.post<{ Params: { id: string } }>("/api/view-links/:id/revoke", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(404).send({ error: "Link not found" });
    const ok = await revokeViewLink(db, { organizationId: request.user!.organizationId, actorId: request.user!.userId, id: request.params.id });
    if (!ok) return reply.code(404).send({ error: "Link not found or already switched off" });
    reply.send({ ok: true });
  });

  // Public: the password screen posts here. Success starts a read-only
  // session (a normal session cookie carrying the link id) that lasts no
  // longer than the link itself.
  app.post("/api/view/unlock", async (request, reply) => {
    const body = z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(200) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Enter the password" });
    try {
      const link = await unlockViewLink(db, body.data.token, body.data.password.trim());
      const token = await signSession({
        userId: link.createdBy,
        organizationId: link.organizationId,
        email: "view-only",
        role: link.includeRestricted ? "admin" : "member",
        viewLinkId: link.id,
      });
      const secondsLeft = Math.max(60, Math.floor((link.expiresAt.getTime() - Date.now()) / 1000));
      reply.setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: config.nodeEnv === "production" ? "none" : "lax",
        secure: config.nodeEnv === "production",
        maxAge: Math.min(secondsLeft, 60 * 60 * 24 * 7),
        path: "/",
      });
      reply.send({ ok: true, expiresAt: link.expiresAt });
    } catch (err) {
      if (err instanceof ViewLinkError) return reply.code(err.code === "locked" ? 429 : 401).send({ error: err.message });
      throw err;
    }
  });
}
