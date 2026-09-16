import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { sources } from "../db/schema.js";
import { UUID_RE } from "./uuid.js";

// A source's rawBody can be a full email/meeting/document -- long, and
// usually never read. Kept out of the suggestions/decisions list responses
// (see suggestions.ts/decisions.ts) and fetched here only when a reviewer
// actually opens the "View source" toggle.
export async function sourceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get<{ Params: { id: string } }>("/api/sources/:id", async (request, reply) => {
    const organizationId = request.user!.organizationId;
    const { id } = request.params;
    if (!UUID_RE.test(id)) {
      reply.code(404).send({ error: "Source not found" });
      return;
    }

    const [source] = await db
      .select({
        id: sources.id,
        type: sources.type,
        externalId: sources.externalId,
        receivedAt: sources.receivedAt,
        rawBody: sources.rawBody,
      })
      .from(sources)
      .where(and(eq(sources.id, id), eq(sources.organizationId, organizationId)));

    if (!source) {
      reply.code(404).send({ error: "Source not found" });
      return;
    }

    reply.send({ source });
  });
}
