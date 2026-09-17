import { randomBytes, createHash } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  auditLog,
  integrationTypeEnum,
  sources,
  suggestions,
  webhookIntegrations,
  type IntegrationType,
  type SourceType,
} from "../db/schema.js";
import { config } from "../config.js";

// Which sources.type value a given webhook integration actually writes --
// kept distinct from IntegrationType (see schema.ts's comment on
// sourceTypeEnum vs integrationTypeEnum) because "email" the integration
// reuses sources.type's existing "gmail" value rather than a third
// overlapping enum member (see webhookIngest.ts's ingestEmailWebhook).
export const SOURCE_TYPE_BY_INTEGRATION: Record<IntegrationType, SourceType> = {
  circleback: "circleback",
  email: "gmail",
};

// sha256, not bcrypt/scrypt: this is a high-entropy machine-generated token,
// not a human password, so a fast cryptographic hash is the correct tool --
// there's no brute-forceable low-entropy input to slow down against.
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface IntegrationStatus {
  type: IntegrationType;
  configured: boolean;
  createdAt: Date | null;
  lastReceivedAt: Date | null;
  // All-time count of suggestions produced from this integration's sources
  // (any status, not just approved) -- "has this integration actually
  // generated anything reviewable" at a glance, before drilling into the
  // per-item activity log.
  totalSuggestions: number;
}

export async function listIntegrations(db: Database, organizationId: string): Promise<IntegrationStatus[]> {
  const [integrationRows, suggestionCountRows] = await Promise.all([
    db.select().from(webhookIntegrations).where(eq(webhookIntegrations.organizationId, organizationId)),
    db
      .select({ sourceType: sources.type, count: count() })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .where(eq(suggestions.organizationId, organizationId))
      .groupBy(sources.type),
  ]);

  const byType = new Map(integrationRows.map((row) => [row.type, row]));
  const suggestionCountBySourceType = new Map(suggestionCountRows.map((row) => [row.sourceType, row.count]));

  return integrationTypeEnum.enumValues.map((type) => {
    const row = byType.get(type);
    return {
      type,
      configured: row !== undefined,
      createdAt: row?.createdAt ?? null,
      lastReceivedAt: row?.lastReceivedAt ?? null,
      totalSuggestions: suggestionCountBySourceType.get(SOURCE_TYPE_BY_INTEGRATION[type]) ?? 0,
    };
  });
}

export interface IntegrationActivityItem {
  id: string;
  externalId: string;
  receivedAt: Date;
  suggestionCount: number;
}

const ACTIVITY_LIMIT = 20;

// Recent ingested items for one integration, newest first, each tagged with
// how many suggestions it produced -- the per-item detail behind
// listIntegrations' totalSuggestions summary. A suggestionCount of 0 just
// means nothing came of this item (classified as noise, or interpretation
// found nothing worth proposing); this can't reliably distinguish which,
// since that verdict isn't persisted anywhere after the fact -- only the
// count itself is a fact.
export async function listIntegrationActivity(
  db: Database,
  organizationId: string,
  type: IntegrationType,
): Promise<IntegrationActivityItem[]> {
  const sourceType = SOURCE_TYPE_BY_INTEGRATION[type];

  const recentSources = await db
    .select({ id: sources.id, externalId: sources.externalId, receivedAt: sources.receivedAt })
    .from(sources)
    .where(and(eq(sources.organizationId, organizationId), eq(sources.type, sourceType)))
    .orderBy(desc(sources.receivedAt))
    .limit(ACTIVITY_LIMIT);

  const sourceIds = recentSources.map((s) => s.id);
  const suggestionCountRows =
    sourceIds.length === 0
      ? []
      : await db
          .select({ sourceId: suggestions.sourceId, count: count() })
          .from(suggestions)
          .where(and(eq(suggestions.organizationId, organizationId), inArray(suggestions.sourceId, sourceIds)))
          .groupBy(suggestions.sourceId);
  const suggestionCountBySourceId = new Map(suggestionCountRows.map((row) => [row.sourceId, row.count]));

  return recentSources.map((source) => ({
    ...source,
    suggestionCount: suggestionCountBySourceId.get(source.id) ?? 0,
  }));
}

// The path itself is keyed by type so a second transcript source later just
// adds another integrationTypeEnum value and another public route, not a
// rewrite of this URL-building logic.
export function webhookUrlFor(type: IntegrationType, rawToken: string): string {
  return `${config.backendUrl}/api/public/webhooks/${type}?token=${rawToken}`;
}

interface GenerateTokenParams {
  organizationId: string;
  actorId: string;
  type: IntegrationType;
}

export interface GeneratedToken {
  type: IntegrationType;
  rawToken: string;
  webhookUrl: string;
  rotated: boolean;
  createdAt: Date;
  lastReceivedAt: Date | null;
}

// Generates (or rotates, if a row already exists for this org+type) a token.
// Only the hash is ever persisted -- the raw token is returned here once and
// is not retrievable again after this call returns.
export async function generateIntegrationToken(db: Database, params: GenerateTokenParams): Promise<GeneratedToken> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(webhookIntegrations)
      .where(and(eq(webhookIntegrations.organizationId, params.organizationId), eq(webhookIntegrations.type, params.type)));

    const [record] = await tx
      .insert(webhookIntegrations)
      .values({ organizationId: params.organizationId, type: params.type, tokenHash })
      .onConflictDoUpdate({
        target: [webhookIntegrations.organizationId, webhookIntegrations.type],
        set: { tokenHash },
      })
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: existing ? "integration.token_rotated" : "integration.token_generated",
      entityType: "webhook_integration",
      entityId: record.id,
      details: { type: params.type },
    });

    return {
      type: record.type,
      rawToken,
      webhookUrl: webhookUrlFor(record.type, rawToken),
      rotated: existing !== undefined,
      createdAt: record.createdAt,
      lastReceivedAt: record.lastReceivedAt,
    };
  });
}
