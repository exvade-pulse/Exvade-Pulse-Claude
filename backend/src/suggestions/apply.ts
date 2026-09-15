import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, initiatives, objectives, projects, suggestions, tasks } from "../db/schema.js";

export class SuggestionApplyError extends Error {}

const TABLE_BY_TARGET_TYPE = {
  objective: objectives,
  initiative: initiatives,
  project: projects,
  task: tasks,
} as const;

// Whitelists what a proposed_diff may set on each target type, so an AI-authored
// (or hand-edited) diff can never smuggle in organization_id or other fields the
// review flow doesn't own.
export const ALLOWED_FIELDS: Record<keyof typeof TABLE_BY_TARGET_TYPE, string[]> = {
  objective: ["title", "description", "status", "priority"],
  initiative: ["objectiveId", "title", "description", "status", "priority"],
  project: ["initiativeId", "title", "description", "status"],
  task: ["projectId", "title", "description", "status", "latestUpdate", "nextAction"],
};

// Exported so the interpretation pipeline can sanitize a model-authored diff
// against the same whitelist this module enforces at apply time -- one source
// of truth for what each target type may set.
export function pickAllowedFields(targetType: keyof typeof TABLE_BY_TARGET_TYPE, diff: Record<string, unknown>) {
  const allowed = ALLOWED_FIELDS[targetType];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in diff) {
      result[key] = diff[key];
    }
  }
  return result;
}

interface ApplyParams {
  organizationId: string;
  suggestionId: string;
  reviewerId: string;
}

export async function approveSuggestion(db: Database, params: ApplyParams) {
  return db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.id, params.suggestionId), eq(suggestions.organizationId, params.organizationId)));

    if (!suggestion) {
      throw new SuggestionApplyError("Suggestion not found");
    }
    if (suggestion.status !== "pending" && suggestion.status !== "edited") {
      throw new SuggestionApplyError(`Suggestion is already ${suggestion.status}`);
    }

    const targetType = suggestion.targetType as keyof typeof TABLE_BY_TARGET_TYPE;
    const table = TABLE_BY_TARGET_TYPE[targetType];
    const fields = pickAllowedFields(targetType, suggestion.proposedDiff as Record<string, unknown>);

    let resultTargetId = suggestion.targetId;

    if (suggestion.targetId) {
      const [updated] = await tx
        .update(table)
        .set({ ...fields, updatedAt: new Date() } as never)
        .where(and(eq(table.id, suggestion.targetId), eq(table.organizationId, params.organizationId)))
        .returning({ id: table.id });

      if (!updated) {
        throw new SuggestionApplyError("Target row not found or not in this organization");
      }
    } else {
      const [created] = await tx
        .insert(table)
        .values({ ...fields, organizationId: params.organizationId } as never)
        .returning({ id: table.id });
      resultTargetId = created.id;
    }

    const [updatedSuggestion] = await tx
      .update(suggestions)
      .set({
        status: "approved",
        targetId: resultTargetId,
        reviewedBy: params.reviewerId,
        reviewedAt: new Date(),
      })
      .where(eq(suggestions.id, suggestion.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.reviewerId,
      action: "suggestion.approved",
      entityType: targetType,
      entityId: resultTargetId,
      details: { suggestionId: suggestion.id, appliedFields: fields },
    });

    return updatedSuggestion;
  });
}

interface EditParams {
  organizationId: string;
  suggestionId: string;
  actorId: string;
  diff: Record<string, unknown>;
}

// Merges a reviewer's partial edit into the existing proposed_diff (the reviewer
// need not resend the whole thing) and re-runs it through pickAllowedFields, so an
// edit is exactly as constrained as the AI's own output was. Does not touch
// reviewedBy/reviewedAt -- an edit is a draft change, not a review decision.
export async function editSuggestion(db: Database, params: EditParams) {
  return db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.id, params.suggestionId), eq(suggestions.organizationId, params.organizationId)));

    if (!suggestion) {
      throw new SuggestionApplyError("Suggestion not found");
    }
    if (suggestion.status !== "pending" && suggestion.status !== "edited") {
      throw new SuggestionApplyError(`Suggestion is already ${suggestion.status}`);
    }

    const targetType = suggestion.targetType as keyof typeof TABLE_BY_TARGET_TYPE;
    const merged = { ...(suggestion.proposedDiff as Record<string, unknown>), ...params.diff };
    const sanitized = pickAllowedFields(targetType, merged);

    const [updatedSuggestion] = await tx
      .update(suggestions)
      .set({ status: "edited", proposedDiff: sanitized })
      .where(eq(suggestions.id, suggestion.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "suggestion.edited",
      entityType: targetType,
      entityId: suggestion.targetId,
      details: { suggestionId: suggestion.id, editedFields: params.diff },
    });

    return updatedSuggestion;
  });
}

export async function rejectSuggestion(db: Database, params: ApplyParams) {
  return db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.id, params.suggestionId), eq(suggestions.organizationId, params.organizationId)));

    if (!suggestion) {
      throw new SuggestionApplyError("Suggestion not found");
    }
    if (suggestion.status !== "pending" && suggestion.status !== "edited") {
      throw new SuggestionApplyError(`Suggestion is already ${suggestion.status}`);
    }

    const [updatedSuggestion] = await tx
      .update(suggestions)
      .set({ status: "rejected", reviewedBy: params.reviewerId, reviewedAt: new Date() })
      .where(eq(suggestions.id, suggestion.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.reviewerId,
      action: "suggestion.rejected",
      entityType: suggestion.targetType,
      entityId: suggestion.targetId,
      details: { suggestionId: suggestion.id },
    });

    return updatedSuggestion;
  });
}
