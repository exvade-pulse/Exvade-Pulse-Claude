import { randomBytes, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, integrationTypeEnum, webhookIntegrations, type IntegrationType } from "../db/schema.js";
import { config } from "../config.js";

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
}

export async function listIntegrations(db: Database, organizationId: string): Promise<IntegrationStatus[]> {
  const rows = await db
    .select()
    .from(webhookIntegrations)
    .where(eq(webhookIntegrations.organizationId, organizationId));
  const byType = new Map(rows.map((row) => [row.type, row]));

  return integrationTypeEnum.enumValues.map((type) => {
    const row = byType.get(type);
    return {
      type,
      configured: row !== undefined,
      createdAt: row?.createdAt ?? null,
      lastReceivedAt: row?.lastReceivedAt ?? null,
    };
  });
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
