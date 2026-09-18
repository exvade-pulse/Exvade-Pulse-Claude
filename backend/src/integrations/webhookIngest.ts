import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { webhookIntegrations, type IntegrationType } from "../db/schema.js";
import { runInterpretationPipeline, type PipelineResult } from "../interpretation/pipeline.js";
import { hashToken } from "./manage.js";
import { parseCirclebackMeta } from "./circlebackPayload.js";
import { parseEmailMeta } from "./emailPayload.js";

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

// Exported for importHistoricalMinutes.ts, which needs the same
// already-ingested-is-a-no-op treatment for its own externalId conflicts.
export function isUniqueViolation(err: unknown): boolean {
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
      // Extracted notes + action items, not the full raw JSON envelope (see
      // circlebackPayload.ts's ParsedCirclebackMeta.body) -- both what lands
      // in sources.rawBody and what interpretation reads. Verified against a
      // real delivery: the full envelope's attendees/tags/signed-recording-
      // URL noise wasn't worth either storing long-term or making the
      // interpretation pass read through.
      body: meta.body,
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

export type EmailIngestOutcome =
  | { outcome: "unauthorized" }
  | { outcome: "duplicate" }
  | ({ outcome: "ingested" } & PipelineResult)
  | { outcome: "pipeline_error"; error: unknown };

// Structurally identical to ingestCirclebackWebhook above -- same token ->
// org lookup, same defensive-parse-then-handoff shape, same dedup/error
// handling -- just for the "email" integration type and Postmark-shaped
// payload. Kept as a separate function rather than parameterizing a shared
// one, mirroring how little there'd be left to share once the payload
// parser and the RawIncomingSource fields it feeds both differ per type.
export async function ingestEmailWebhook(
  db: Database,
  rawToken: string,
  rawBodyText: string,
): Promise<EmailIngestOutcome> {
  const integration = await findIntegrationByToken(db, "email", rawToken);
  if (!integration) {
    return { outcome: "unauthorized" };
  }

  const meta = parseEmailMeta(rawBodyText);

  try {
    const result = await runInterpretationPipeline(db, integration.organizationId, {
      // Reuses source_type's existing "gmail" value rather than introducing
      // a third overlapping "this is an email" enum value -- "gmail" already
      // means "email-shaped ingestion" elsewhere in this codebase
      // (seedFakeSuggestion.ts, runRealInterpretation.ts). The mismatch
      // between that literal name and "any inbound email via Postmark" is
      // pre-existing and out of scope to rename here.
      type: "gmail",
      externalId: meta.externalId,
      subject: meta.subject,
      from: meta.from,
      body: meta.body,
      receivedAt: meta.receivedAt,
    });

    await db
      .update(webhookIntegrations)
      .set({ lastReceivedAt: new Date() })
      .where(eq(webhookIntegrations.id, integration.id));

    return { outcome: "ingested", ...result };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Same-org, same-message-id redelivery (a provider retry, or the same
      // email forwarded twice) is an expected no-op, not an error.
      await db
        .update(webhookIntegrations)
        .set({ lastReceivedAt: new Date() })
        .where(eq(webhookIntegrations.id, integration.id));
      return { outcome: "duplicate" };
    }
    return { outcome: "pipeline_error", error: err };
  }
}
