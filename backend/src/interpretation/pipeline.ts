import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { decisions, initiatives, objectives, projects, sources, tasks } from "../db/schema.js";
import { isNoiseSource } from "./noiseFilter.js";
import { interpretSource, InterpretationError, type CompanyContext } from "./interpret.js";
import {
  redactPatientIdentifiers,
  RedactionError,
  REDACTION_FAILURE_PLACEHOLDER_BODY,
} from "./redactPatientIdentifiers.js";
import { getClaudeClient, type ClaudeClient } from "./claudeClient.js";
import { mergeOrInsertSuggestion } from "../suggestions/dedupe.js";

export interface RawIncomingSource {
  type: "gmail" | "circleback" | "document" | "manual";
  externalId: string;
  subject: string;
  from: string;
  body: string;
  receivedAt: Date;
}

export interface PipelineResult {
  sourceId: string;
  // One source can now yield more than one suggestion (a genuinely
  // multi-topic document) -- empty when interpretation failed or found
  // nothing worth proposing, same as suggestionId === null used to mean.
  suggestionIds: string[];
  skippedAsNoise: boolean;
}

async function loadCompanyContext(db: Database, organizationId: string): Promise<CompanyContext> {
  const [objectiveRows, initiativeRows, projectRows, taskRows, decisionRows] = await Promise.all([
    db
      .select({ id: objectives.id, title: objectives.title, status: objectives.status })
      .from(objectives)
      .where(eq(objectives.organizationId, organizationId)),
    db
      .select({ id: initiatives.id, title: initiatives.title, status: initiatives.status })
      .from(initiatives)
      .where(eq(initiatives.organizationId, organizationId)),
    db
      .select({ id: projects.id, title: projects.title, status: projects.status })
      .from(projects)
      .where(eq(projects.organizationId, organizationId)),
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.organizationId, organizationId)),
    // Only `open` decisions are offered as match candidates -- a `decided` one
    // is closed and shouldn't be reopened by an interpretation match.
    db
      .select({
        id: decisions.id,
        title: decisions.title,
        status: decisions.status,
        decider: decisions.decider,
        whyItMatters: decisions.whyItMatters,
      })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), eq(decisions.status, "open"))),
  ]);

  return {
    objectives: objectiveRows,
    initiatives: initiativeRows,
    projects: projectRows,
    tasks: taskRows,
    decisions: decisionRows,
  };
}

// The real ingestion entry point: given one raw source, redacts patient
// identifiers BEFORE anything is written to the database (raw.body itself is
// never inserted, not even transiently), always keeps a `sources` row for
// traceability (per the schema's audit-first design), runs the cheap noise
// pre-pass, and only on a "worth it" verdict runs the real interpretation
// pass and writes a `suggestions` row. A source that is noise, or whose
// interpretation response we couldn't trust, is left with no suggestion rather
// than a fabricated one -- but the source row itself is never silently dropped.
//
// If redaction itself fails, this fails CLOSED (opposite of the noise filter
// below): the `sources` row still gets written for traceability, but with a
// safe placeholder body instead of raw.body, and the pipeline stops there --
// no noise check, no interpretation, no suggestion -- leaving it for a human
// to review rather than risk persisting or interpreting unredacted content.
export async function runInterpretationPipeline(
  db: Database,
  organizationId: string,
  raw: RawIncomingSource,
  // Defaulted (not required) so every existing caller and test is unaffected;
  // the batch import script overrides this with a retry-wrapping client, since
  // it needs to survive rate limits across ~200 docs without pipeline.ts's own
  // fail-open/fail-closed handling mistaking a 429 for a genuine failure.
  claudeClient: ClaudeClient = getClaudeClient(),
): Promise<PipelineResult> {
  let redactedBody: string;
  try {
    redactedBody = await redactPatientIdentifiers(raw.body, claudeClient);
  } catch (err) {
    if (!(err instanceof RedactionError)) throw err;
    console.error(`Patient-identifier redaction failed for an incoming ${raw.type} source (external id ${raw.externalId}); storing a safe placeholder instead of raw content:`, err.message);

    const [source] = await db
      .insert(sources)
      .values({
        organizationId,
        type: raw.type,
        externalId: raw.externalId,
        receivedAt: raw.receivedAt,
        rawBody: REDACTION_FAILURE_PLACEHOLDER_BODY,
      })
      .returning();

    return { sourceId: source.id, suggestionIds: [], skippedAsNoise: false };
  }

  const [source] = await db
    .insert(sources)
    .values({
      organizationId,
      type: raw.type,
      externalId: raw.externalId,
      receivedAt: raw.receivedAt,
      rawBody: redactedBody,
    })
    .returning();

  const noiseCheck = await isNoiseSource({ subject: raw.subject, from: raw.from, body: redactedBody }, claudeClient);
  if (noiseCheck.isNoise) {
    return { sourceId: source.id, suggestionIds: [], skippedAsNoise: true };
  }

  const context = await loadCompanyContext(db, organizationId);

  try {
    const drafts = await interpretSource(
      { subject: raw.subject, from: raw.from, body: redactedBody, receivedAt: raw.receivedAt },
      context,
      claudeClient,
    );

    // One transaction for the whole batch of drafts from this source, so a
    // multi-topic source's suggestions either all land or none do. Each
    // draft either merges into an already-pending suggestion targeting the
    // same entity, or lands as a new row -- see mergeOrInsertSuggestion.
    const results = await db.transaction(async (tx) => {
      const rows: Awaited<ReturnType<typeof mergeOrInsertSuggestion>>[] = [];
      for (const draft of drafts) {
        rows.push(
          await mergeOrInsertSuggestion(tx, {
            organizationId,
            sourceId: source.id,
            sourceReceivedAt: raw.receivedAt,
            draft,
          }),
        );
      }
      return rows;
    });

    return { sourceId: source.id, suggestionIds: results.map((r) => r.id), skippedAsNoise: false };
  } catch (err) {
    if (err instanceof InterpretationError) {
      console.error(`Interpretation failed for source ${source.id}:`, err.message);
      return { sourceId: source.id, suggestionIds: [], skippedAsNoise: false };
    }
    throw err;
  }
}
