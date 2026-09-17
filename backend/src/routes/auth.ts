import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildGoogleAuthUrl, exchangeCodeForUserInfo } from "../auth/google.js";
import { findOrCreateUserForGoogleIdentity, SignInRejectedError } from "../auth/identity.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { db } from "../db/client.js";

const STATE_COOKIE_NAME = "pulse_oauth_state";

export async function authRoutes(app: FastifyInstance) {
  app.get("/auth/google", async (request, reply) => {
    const state = randomUUID();
    reply.setCookie(STATE_COOKIE_NAME, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: 60 * 10,
      path: "/",
    });
    reply.redirect(buildGoogleAuthUrl(state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/google/callback",
    async (request, reply) => {
      const { code, state, error } = request.query;
      const expectedState = request.cookies[STATE_COOKIE_NAME];
      reply.clearCookie(STATE_COOKIE_NAME, { path: "/" });

      if (error || !code || !state || state !== expectedState) {
        reply.code(400).send({ error: "Invalid OAuth callback" });
        return;
      }

      const userInfo = await exchangeCodeForUserInfo(code);

      // Never trust an unverified email, regardless of which domain admits
      // the sign-in below -- everything past this point (the home-domain
      // bootstrap and the cross-domain invite lookup, both in identity.ts)
      // assumes the email genuinely belongs to this Google account.
      if (!userInfo.email_verified) {
        reply.code(403).send({ error: "Your Google account's email isn't verified" });
        return;
      }

      let org, user, role;
      try {
        ({ org, user, role } = await findOrCreateUserForGoogleIdentity(db, {
          googleId: userInfo.sub,
          email: userInfo.email,
          name: userInfo.name,
        }));
      } catch (err) {
        if (err instanceof SignInRejectedError) {
          reply.code(403).send({ error: err.message });
          return;
        }
        throw err;
      }

      const token = await signSession({ userId: user.id, organizationId: org.id, email: user.email, role });

      reply.setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: config.nodeEnv === "production" ? "none" : "lax",
        secure: config.nodeEnv === "production",
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
      });

      reply.redirect(config.frontendUrl);
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    reply.send({ ok: true });
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ user: request.user });
  });
}
