import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { initiatives, objectives, projects, sources, suggestions, tasks } from "../db/schema.js";
import { isNoiseSource } from "./noiseFilter.js";
import { interpretSource, InterpretationError, type CompanyContext } from "./interpret.js";

export interface RawIncomingSource {
  type: "gmail" | "circleback";
  externalId: string;
  subject: string;
  from: string;
  body: string;
  receivedAt: Date;
}

export interface PipelineResult {
  sourceId: string;
  suggestionId: string | null;
  skippedAsNoise: boolean;
}

async function loadCompanyContext(db: Database, organizationId: string): Promise<CompanyContext> {
  const [objectiveRows, initiativeRows, projectRows, taskRows] = await Promise.all([
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
  ]);

  return { objectives: objectiveRows, initiatives: initiativeRows, projects: projectRows, tasks: taskRows };
}

// The real ingestion entry point: given one raw source, always keeps a `sources`
// row for traceability (per the schema's audit-first design), runs the cheap
// noise pre-pass, and only on a "worth it" verdict runs the real interpretation
// pass and writes a `suggestions` row. A source that is noise, or whose
// interpretation response we couldn't trust, is left with no suggestion rather
// than a fabricated one -- but the source row itself is never silently dropped.
export async function runInterpretationPipeline(
  db: Database,
  organizationId: string,
  raw: RawIncomingSource,
): Promise<PipelineResult> {
  const [source] = await db
    .insert(sources)
    .values({
      organizationId,
      type: raw.type,
      externalId: raw.externalId,
      receivedAt: raw.receivedAt,
      rawBody: raw.body,
    })
    .returning();

  const noiseCheck = await isNoiseSource({ subject: raw.subject, from: raw.from, body: raw.body });
  if (noiseCheck.isNoise) {
    return { sourceId: source.id, suggestionId: null, skippedAsNoise: true };
  }

  const context = await loadCompanyContext(db, organizationId);

  try {
    const draft = await interpretSource(
      { subject: raw.subject, from: raw.from, body: raw.body, receivedAt: raw.receivedAt },
      context,
    );

    const [suggestion] = await db
      .insert(suggestions)
      .values({
        organizationId,
        sourceId: source.id,
        targetType: draft.targetType,
        targetId: draft.targetId,
        changeType: draft.changeType,
        proposedDiff: draft.proposedDiff,
        reasoning: draft.reasoning,
        confidence: draft.confidence,
      })
      .returning();

    return { sourceId: source.id, suggestionId: suggestion.id, skippedAsNoise: false };
  } catch (err) {
    if (err instanceof InterpretationError) {
      console.error(`Interpretation failed for source ${source.id}:`, err.message);
      return { sourceId: source.id, suggestionId: null, skippedAsNoise: false };
    }
    throw err;
  }
}
