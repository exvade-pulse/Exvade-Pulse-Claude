import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { companyMapRoutes } from "./routes/companyMap.js";
import { suggestionRoutes } from "./routes/suggestions.js";
import { decisionRoutes } from "./routes/decisions.js";
import { userRoutes } from "./routes/users.js";
import { integrationRoutes } from "./routes/integrations.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { activityRoutes } from "./routes/activity.js";
import { sourceRoutes } from "./routes/sources.js";
import { reportRoutes } from "./routes/reports.js";
import { searchRoutes } from "./routes/search.js";
import { entityRoutes } from "./routes/entities.js";
import { relationshipRoutes } from "./routes/relationships.js";
import { gmailAuthRoutes } from "./routes/gmailAuth.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: config.frontendUrl,
    credentials: true,
  });
  await app.register(cookie);

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(suggestionRoutes);
  await app.register(dashboardRoutes);
  await app.register(companyMapRoutes);
  await app.register(decisionRoutes);
  await app.register(userRoutes);
  await app.register(integrationRoutes);
  await app.register(webhookRoutes);
  await app.register(activityRoutes);
  await app.register(sourceRoutes);
  await app.register(reportRoutes);
  await app.register(searchRoutes);
  await app.register(entityRoutes);
  await app.register(relationshipRoutes);
  await app.register(gmailAuthRoutes);

  return app;
}
