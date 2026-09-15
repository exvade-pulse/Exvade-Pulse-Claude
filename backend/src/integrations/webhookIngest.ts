import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { webhookIntegrations, type IntegrationType } from "../db/schema.js";
import { runInterpretationPipeline, type PipelineResult } from "../interpretation/pipeline.js";
import { hashToken } from "./manage.js";
import { parseCirclebackMeta } from "./circlebackPayload.js";

interface MatchedIntegration {
  id: string;
  organizationId: string;
}

async function findIntegrationByToken(
  db: Database,
  type: IntegrationType,
  rawToken: string,
): Promise<MatchedIntegration | null> {
  const tokenHash = hashToken(rawToken);
  const [row] = await db
    .select({ id: webhookIntegrations.id, organizationId: webhookIntegrations.organizationId })
    .from(webhookIntegrations)
    .where(and(eq(webhookIntegrations.type, type), eq(webhookIntegrations.tokenHash, tokenHash)));
  return row ?? null;
}

// Postgres unique_violation (23505). Drizzle wraps the underlying
// `postgres`-driver PostgresError in a DrizzleQueryError, putting the real
// error (and its .code) on `.cause` -- so both layers are checked.
function hasUniqueViolationCode(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
}

function isUniqueViolation(err: unknown): boolean {
  if (hasUniqueViolationCode(err)) return true;
  if (err instanceof Error && err.cause) return hasUniqueViolationCode(err.cause);
  return false;
}

export type CirclebackIngestOutcome =
  | { outcome: "unauthorized" }
  | { outcome: "duplicate" }
  | ({ outcome: "ingested" } & PipelineResult)
  | { outcome: "pipeline_error"; error: unknown };

// The public webhook entry point: token -> org lookup, defensive payload
// parsing, then a straight handoff into the existing (source-type-agnostic)
// interpretation pipeline. Runs synchronously in-request -- there's no job
// queue in this codebase yet and current traffic doesn't need one, but this
// should move to an async queue if/when ingestion volume grows.
export async function ingestCirclebackWebhook(
  db: Database,
  rawToken: string,
  rawBodyText: string,
): Promise<CirclebackIngestOutcome> {
  const integration = await findIntegrationByToken(db, "circleback", rawToken);
  if (!integration) {
    return { outcome: "unauthorized" };
  }

  const meta = parseCirclebackMeta(rawBodyText);

  try {
    const result = await runInterpretationPipeline(db, integration.organizationId, {
      type: "circleback",
      externalId: meta.externalId,
      subject: meta.title,
      from: "Circleback",
      // The full raw JSON payload, verbatim -- this is what lands in
      // sources.rawBody, so nothing is lost even where the field-name
      // guessing above misses. It's also what the interpretation pass reads,
      // same as pipeline.ts already does for gmail sources.
      body: rawBodyText,
      receivedAt: meta.occurredAt,
    });

    await db
      .update(webhookIntegrations)
      .set({ lastReceivedAt: new Date() })
      .where(eq(webhookIntegrations.id, integration.id));

    return { outcome: "ingested", ...result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Circleback retries delivery on a non-200 response or a timeout, so a
      // repeat of a meeting we've already ingested (same org + externalId) is
      // an expected retry, not an error.
      await db
        .update(webhookIntegrations)
        .set({ lastReceivedAt: new Date() })
        .where(eq(webhookIntegrations.id, integration.id));
      return { outcome: "duplicate" };
    }
    return { outcome: "pipeline_error", error: err };
  }
}
