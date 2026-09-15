import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { suggestionRoutes } from "./routes/suggestions.js";
import { decisionRoutes } from "./routes/decisions.js";

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
  await app.register(decisionRoutes);

  return app;
}
