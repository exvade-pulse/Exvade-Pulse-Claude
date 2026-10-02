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
import { unsortedRoutes } from "./routes/unsorted.js";
import { duplicateRoutes } from "./routes/duplicates.js";
import { relationshipSuggestionRoutes } from "./routes/relationshipSuggestions.js";
import { chatGptRoutes } from "./routes/chatgpt.js";
import { publicReviewRoutes } from "./routes/publicReview.js";
import { contradictionRoutes } from "./routes/contradictions.js";
import { cleanupRoutes } from "./routes/cleanup.js";
import { questionRoutes } from "./routes/questions.js";
import { companyContextRoutes } from "./routes/companyContext.js";
import { viewLinkRoutes } from "./routes/viewLinks.js";
import { reviewFindingsRoutes } from "./routes/reviewFindings.js";
import { overviewRoutes } from "./routes/overview.js";

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
  await app.register(unsortedRoutes);
  await app.register(duplicateRoutes);
  await app.register(relationshipSuggestionRoutes);
  await app.register(chatGptRoutes);
  await app.register(publicReviewRoutes);
  await app.register(contradictionRoutes);
  await app.register(cleanupRoutes);
  await app.register(questionRoutes);
  await app.register(companyContextRoutes);
  await app.register(viewLinkRoutes);
  await app.register(reviewFindingsRoutes);
  await app.register(overviewRoutes);

  return app;
}
