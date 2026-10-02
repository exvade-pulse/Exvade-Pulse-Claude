import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { sources, suggestions } from "../db/schema.js";
import { getContextualClaudeClient } from "../context/companyContext.js";
import { getClaudeClient } from "../interpretation/claudeClient.js";
import { redactPatientIdentifiers, RedactionError } from "../interpretation/redactPatientIdentifiers.js";
import {
  loadFindingsContext,
  proposeFromFindings,
  splitIntoChunks,
  type AppFeedbackItem,
  type FindingProposal,
  type UnresolvedItem,
} from "../interpretation/reviewFindings.js";

const MAX_DOCUMENT_CHARS = 200_000;
const CONCURRENCY = 3;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
// Anything the reviewer said to verify never lands in "Ready to approve".
const VERIFY_CONFIDENCE_CAP = 0.6;

interface Job {
  id: string;
  organizationId: string;
  status: "running" | "done" | "failed";
  partsTotal: number;
  partsDone: number;
  proposals: number;
  byKind: Record<string, number>;
  needsVerification: number;
  appFeedback: AppFeedbackItem[];
  // Instructions Pulse couldn't act on, with why -- shown so nothing is
  // skipped silently.
  unresolved: UnresolvedItem[];
  errors: string[];
  startedAt: number;
}

// In memory: a job only needs to outlive the few minutes the page polls it.
const jobs = new Map<string, Job>();

function publicJob(job: Job) {
  const { organizationId: _org, startedAt: _started, ...rest } = job;
  return rest;
}

// Same record touched in more than one part: fold into one proposal.
function combine(all: FindingProposal[]): FindingProposal[] {
  const out: FindingProposal[] = [];
  const updates = new Map<string, Extract<FindingProposal, { kind: "update" }>>();
  const merges = new Set<string>();
  const questions = new Set<string>();
  for (const p of all) {
    if (p.kind === "update") {
      const existing = updates.get(p.targetId);
      if (existing) {
        existing.fields = { ...existing.fields, ...p.fields };
        existing.reasoning = `${existing.reasoning} ${p.finding ? `[${p.finding}] ` : ""}${p.reasoning}`;
        existing.needsVerification ||= p.needsVerification;
        existing.verifyNote = [existing.verifyNote, p.verifyNote].filter(Boolean).join(" ") || null;
        existing.confidence = Math.min(existing.confidence, p.confidence);
        continue;
      }
      updates.set(p.targetId, p);
    } else if (p.kind === "merge") {
      if (merges.has(p.duplicateId)) continue;
      merges.add(p.duplicateId);
    } else if (p.kind === "question") {
      const key = p.proposal.title.toLowerCase();
      if (questions.has(key)) continue;
      questions.add(key);
    }
    out.push(p);
  }
  return out;
}

function toRow(p: FindingProposal, organizationId: string, sourceId: string) {
  const reasoning = `${p.finding ? `[${p.finding}] ` : ""}${p.reasoning}${p.needsVerification && p.verifyNote ? ` Verify: ${p.verifyNote}` : ""}`;
  const confidence = p.needsVerification ? Math.min(p.confidence, VERIFY_CONFIDENCE_CAP) : p.confidence;
  const conflicts = [{ kind: "review", finding: p.finding, needsVerification: p.needsVerification, verifyNote: p.verifyNote }];
  const base = { organizationId, sourceId, reasoning, confidence, conflicts };
  switch (p.kind) {
    case "update":
      return { ...base, targetType: p.targetType, targetId: p.targetId, changeType: "operational_update" as const, proposedDiff: p.fields };
    case "create":
      return { ...base, targetType: p.targetType, targetId: null, changeType: p.targetType === "decision" ? ("decision" as const) : ("new_task" as const), proposedDiff: p.fields };
    case "merge":
      return { ...base, targetType: p.targetType, targetId: p.duplicateId, changeType: "merge" as const, proposedDiff: { supersededById: p.keepId } };
    case "question":
      return { ...base, targetType: "question" as const, targetId: null, changeType: "question" as const, proposedDiff: p.proposal };
  }
}

async function runJob(job: Job, text: string) {
  try {
    const chunks = splitIntoChunks(text);
    job.partsTotal = chunks.length;
    const ctx = await loadFindingsContext(db, job.organizationId);
    const aiClient = await getContextualClaudeClient(db, job.organizationId);
    const redactionClient = getClaudeClient();

    const results: Array<{ redacted: string; proposals: FindingProposal[]; appFeedback: AppFeedbackItem[]; unresolved: UnresolvedItem[] } | null> = new Array(chunks.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        try {
          const redacted = await redactPatientIdentifiers(chunks[i], redactionClient);
          const found = await proposeFromFindings(redacted, ctx, `part ${i + 1} of ${chunks.length}`, aiClient);
          results[i] = { redacted, ...found };
        } catch (err) {
          job.errors.push(
            err instanceof RedactionError
              ? `Part ${i + 1} was skipped: it couldn't be safely screened for patient identifiers.`
              : `Part ${i + 1} was skipped: the AI step failed (${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}).`,
          );
        } finally {
          job.partsDone++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

    const done = results.filter((r): r is NonNullable<typeof r> => r !== null);
    const proposals = combine(done.flatMap((r) => r.proposals));
    job.unresolved = done.flatMap((r) => r.unresolved).slice(0, 200);
    const seenFeedback = new Set<string>();
    job.appFeedback = done
      .flatMap((r) => r.appFeedback)
      .filter((f) => {
        const key = `${f.area}|${f.issue}`.toLowerCase();
        if (seenFeedback.has(key)) return false;
        seenFeedback.add(key);
        return true;
      });

    if (proposals.length > 0) {
      // The stored source is the screened document, so "View source" on
      // each proposal shows the finding it came from.
      const [source] = await db
        .insert(sources)
        .values({
          organizationId: job.organizationId,
          type: "manual",
          externalId: randomUUID(),
          receivedAt: new Date(),
          rawBody: `Review findings (pasted into Review)\n\n${done.map((r) => r.redacted).join("\n\n")}`,
        })
        .returning();
      await db.insert(suggestions).values(proposals.map((p) => toRow(p, job.organizationId, source.id)));
    }
    job.proposals = proposals.length;
    for (const p of proposals) job.byKind[p.kind] = (job.byKind[p.kind] ?? 0) + 1;
    job.needsVerification = proposals.filter((p) => p.needsVerification).length;
    job.status = "done";
  } catch (err) {
    job.status = "failed";
    job.errors.push(err instanceof Error ? err.message.slice(0, 200) : "Something went wrong");
  }
}

export async function reviewFindingsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.post("/api/reviews/findings", async (request, reply) => {
    const body = z.object({ text: z.string().min(1) }).safeParse(request.body);
    const text = body.success ? body.data.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "Paste the review findings" });
    if (text.length > MAX_DOCUMENT_CHARS) {
      return reply.code(400).send({ error: `That's too long (over ${MAX_DOCUMENT_CHARS.toLocaleString()} characters). Paste it in two halves.` });
    }
    const now = Date.now();
    for (const [id, j] of jobs) if (now - j.startedAt > JOB_TTL_MS) jobs.delete(id);

    const job: Job = {
      id: randomUUID(),
      organizationId: request.user!.organizationId,
      status: "running",
      partsTotal: splitIntoChunks(text).length,
      partsDone: 0,
      proposals: 0,
      byKind: {},
      needsVerification: 0,
      appFeedback: [],
      unresolved: [],
      errors: [],
      startedAt: now,
    };
    jobs.set(job.id, job);
    void runJob(job, text);
    reply.code(202).send(publicJob(job));
  });

  app.get<{ Params: { id: string } }>("/api/reviews/findings/:id", async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job || job.organizationId !== request.user!.organizationId) return reply.code(404).send({ error: "Not found (it may have finished over two hours ago)" });
    reply.send(publicJob(job));
  });
}
