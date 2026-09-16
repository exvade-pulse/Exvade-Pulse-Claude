import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { sources } from "../db/schema.js";
import { runInterpretationPipeline } from "../interpretation/pipeline.js";
import { UUID_RE } from "./uuid.js";

// A short, contentful subject for the interpretation prompt (which reads
// subject/from/body the same way it does for email) -- the note's own first
// line rather than a generic "Manual update" label that would tell the model
// nothing. Falls back to a fixed label only when the note is empty of any
// distinguishing first line (shouldn't happen once the length check below
// passes, but keeps this total).
const SUBJECT_LENGTH = 80;
function deriveSubject(note: string): string {
  const firstLine = note.split("\n")[0]?.trim();
  if (!firstLine) return "Manual update";
  return firstLine.length > SUBJECT_LENGTH ? `${firstLine.slice(0, SUBJECT_LENGTH)}…` : firstLine;
}

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

  // A direct-entry alternative to email/Circleback/document ingestion -- a
  // quick "type a note" path that still goes through the exact same
  // redaction -> noise-filter -> interpretation pipeline as every other
  // source, rather than a shortcut that writes tasks/decisions straight from
  // free text. No dedup key exists for typed notes the way externalId does
  // for a webhook delivery -- each submission gets its own randomUUID, since
  // a user resubmitting the same words is a legitimate repeat note, not a
  // retry to collapse.
  app.post<{ Body: { note?: string } }>("/api/sources/manual", async (request, reply) => {
    const note = request.body?.note?.trim();
    if (!note) {
      reply.code(400).send({ error: "Note text is required" });
      return;
    }

    const organizationId = request.user!.organizationId;
    const result = await runInterpretationPipeline(db, organizationId, {
      type: "manual",
      externalId: randomUUID(),
      subject: deriveSubject(note),
      from: request.user!.email,
      body: note,
      receivedAt: new Date(),
    });

    reply.send(result);
  });
}
