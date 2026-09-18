import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { gmailConnections } from "../db/schema.js";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { buildGmailAuthUrl, exchangeGmailCode, fetchGmailProfileEmail, GmailAuthError } from "../integrations/gmailOAuth.js";

const STATE_COOKIE_NAME = "pulse_gmail_oauth_state";

export async function gmailAuthRoutes(app: FastifyInstance) {
  // Admin-only, session-gated: connecting a Gmail inbox is an admin action
  // like everything else under Integrations. The person clicking this needs
  // to be signed into the *target* Google account (e.g. pulse@exvadebio.com)
  // in their browser when Google's consent screen appears -- not their own
  // Pulse admin account's Google identity, which is a separate, unrelated
  // session on accounts.google.com.
  app.get("/auth/gmail/connect", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const state = randomUUID();
    reply.setCookie(STATE_COOKIE_NAME, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: 60 * 10,
      path: "/",
    });
    reply.redirect(buildGmailAuthUrl(state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/gmail/callback",
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { code, state, error } = request.query;
      const expectedState = request.cookies[STATE_COOKIE_NAME];
      reply.clearCookie(STATE_COOKIE_NAME, { path: "/" });

      const integrationsUrl = `${config.frontendUrl}/integrations`;

      if (error || !code || !state || state !== expectedState) {
        reply.redirect(`${integrationsUrl}?gmail_error=${encodeURIComponent("Invalid OAuth callback")}`);
        return;
      }

      try {
        const tokens = await exchangeGmailCode(code);
        const emailAddress = await fetchGmailProfileEmail(tokens.accessToken);

        await db
          .insert(gmailConnections)
          .values({
            organizationId: request.user!.organizationId,
            emailAddress,
            refreshToken: tokens.refreshToken,
            connectedBy: request.user!.userId,
          })
          .onConflictDoUpdate({
            target: gmailConnections.organizationId,
            // Reconnecting replaces the credential and email address, but
            // deliberately leaves lastHistoryId alone if a row already
            // existed -- only a genuinely new connection (the insert path)
            // starts with no cursor. drizzle-orm/pg-core's onConflictDoUpdate
            // doesn't expose "leave column as-is" directly, so lastHistoryId
            // is set back to its own current value via a raw excluded-vs-
            // existing guard would need a case expression; simplest correct
            // behavior instead: a reconnect always re-baselines with a full
            // resync (null lastHistoryId), which is safe -- it may re-surface
            // a few already-ingested messages, but runInterpretationPipeline's
            // externalId uniqueness makes that a no-op, not a duplicate.
            set: {
              emailAddress,
              refreshToken: tokens.refreshToken,
              connectedBy: request.user!.userId,
              lastHistoryId: null,
              lastSyncError: null,
              updatedAt: new Date(),
            },
          });

        reply.redirect(integrationsUrl);
      } catch (err) {
        const message = err instanceof GmailAuthError ? err.message : "Failed to connect Gmail";
        reply.redirect(`${integrationsUrl}?gmail_error=${encodeURIComponent(message)}`);
      }
    },
  );

  app.delete("/api/integrations/gmail", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    await db.delete(gmailConnections).where(eq(gmailConnections.organizationId, request.user!.organizationId));
    reply.send({ ok: true });
  });
}
