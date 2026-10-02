import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, objectiveHealthEnum, objectiveHealthHistory, objectives, type ObjectiveHealth } from "../db/schema.js";

export class HealthError extends Error {}

// Records a person's health assessment of an outcome: the current value on
// the objective (what the overview shows) plus a history row (trend and
// audit trail), in one transaction. An assessment other than "not
// assessed" needs a reason -- a bare color is exactly what the overview is
// meant to avoid.
export async function setObjectiveHealth(
  db: Database,
  params: {
    organizationId: string;
    objectiveId: string;
    actorId: string;
    actorName: string;
    health: string;
    rationale?: string | null;
    overrideReason?: string | null;
    reviewBy?: string | null;
  },
) {
  if (!objectiveHealthEnum.enumValues.includes(params.health as ObjectiveHealth)) {
    throw new HealthError(`Health must be one of: ${objectiveHealthEnum.enumValues.join(", ")}`);
  }
  const health = params.health as ObjectiveHealth;
  const rationale = params.rationale?.trim() || null;
  if (health !== "not_assessed" && !rationale) throw new HealthError("Give a one-line reason for this assessment");
  const reviewBy = params.reviewBy ? new Date(`${params.reviewBy.slice(0, 10)}T00:00:00.000Z`) : null;
  if (reviewBy && Number.isNaN(reviewBy.getTime())) throw new HealthError("Review-by must be a date (YYYY-MM-DD)");

  return db.transaction(async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(objectives)
      .set({ health, healthRationale: rationale, healthAssessedAt: now, healthAssessedBy: params.actorName, updatedAt: now })
      .where(and(eq(objectives.id, params.objectiveId), eq(objectives.organizationId, params.organizationId), inArray(objectives.status, ["active", "paused"])))
      .returning();
    if (!updated) throw new HealthError("Objective not found");
    await tx.insert(objectiveHealthHistory).values({
      organizationId: params.organizationId,
      objectiveId: params.objectiveId,
      health,
      rationale,
      assessedAt: now,
      assessedBy: params.actorName,
      source: "person",
      overrideReason: params.overrideReason?.trim() || null,
      reviewBy,
    });
    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "objective.health_assessed",
      entityType: "objective",
      entityId: params.objectiveId,
      details: { health, rationale, overrideReason: params.overrideReason ?? null },
    });
    return updated;
  });
}
