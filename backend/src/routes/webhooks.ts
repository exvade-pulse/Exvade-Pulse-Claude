import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { ingestCirclebackWebhook, ingestEmailWebhook } from "../integrations/webhookIngest.js";

export async function webhookRoutes(app: FastifyInstance) {
  // Public and token-gated, not session-gated: Circleback (or any future
  // transcript source) has no Exvade Pulse user session to send. The token in
  // the query string is the only credential -- anything without a valid one
  // is rejected before anything is ingested.
  app.post<{ Querystring: { token?: string }; Body: unknown }>(
    "/api/public/webhooks/circleback",
    async (request, reply) => {
      const token = request.query.token;
      if (!token) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }

      const rawBodyText = JSON.stringify(request.body ?? {});
      const result = await ingestCirclebackWebhook(db, token, rawBodyText);

      switch (result.outcome) {
        case "unauthorized":
          // Same response as a missing token -- never leak whether a bad
          // token was "no such token" vs anything else.
          reply.code(401).send({ error: "Unauthorized" });
          return;
        case "duplicate":
        case "ingested":
          reply.code(200).send({ ok: true });
          return;
        case "pipeline_error":
          // The `sources` row is already committed even though this branch
          // threw later (see webhookIngest.ts) -- ingestion happened, only
          // interpretation failed. 5xx so Circleback retries, unlike the
          // duplicate-externalId case above, which is an expected retry, not
          // an error.
          request.log.error(result.error, "Circleback webhook: interpretation pipeline failed");
          reply.code(502).send({ error: "Ingestion succeeded but interpretation failed" });
          return;
      }
    },
  );

  // Same token-gated, not-session-gated shape as the Circleback route above:
  // an inbound-email provider (Postmark-shaped payload, see emailPayload.ts)
  // has no Exvade Pulse user session either.
  app.post<{ Querystring: { token?: string }; Body: unknown }>(
    "/api/public/webhooks/email",
    async (request, reply) => {
      const token = request.query.token;
      if (!token) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }

      const rawBodyText = JSON.stringify(request.body ?? {});
      const result = await ingestEmailWebhook(db, token, rawBodyText);

      switch (result.outcome) {
        case "unauthorized":
          reply.code(401).send({ error: "Unauthorized" });
          return;
        case "duplicate":
        case "ingested":
          reply.code(200).send({ ok: true });
          return;
        case "pipeline_error":
          request.log.error(result.error, "Email webhook: interpretation pipeline failed");
          reply.code(502).send({ error: "Ingestion succeeded but interpretation failed" });
          return;
      }
    },
  );
}
