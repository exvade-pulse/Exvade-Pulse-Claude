import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, initiatives, objectives, projects, suggestions, tasks } from "../db/schema.js";
import { createDecision, updateDecision } from "../decisions/manage.js";

export class SuggestionApplyError extends Error {}

const TABLE_BY_TARGET_TYPE = {
  objective: objectives,
  initiative: initiatives,
  project: projects,
  task: tasks,
} as const;

// "decision" is a valid suggestion targetType but deliberately has no entry in
// TABLE_BY_TARGET_TYPE: creating a decision isn't a drop-in "insert this table
// with whitelisted fields" case like the other four (it needs org-scoped
// relatedTaskId/sourceId validation and its own audit_log entry, which already
// live in decisions/manage.ts's createDecision), so it's handled as its own
// branch in approveSuggestion instead. ALLOWED_FIELDS/pickAllowedFields still
// cover it, since interpret.ts's sanitization step whitelists every targetType
// the model may propose, this one included.
export type SuggestionTargetType = keyof typeof TABLE_BY_TARGET_TYPE | "decision";

// Whitelists what a proposed_diff may set on each target type, so an AI-authored
// (or hand-edited) diff can never smuggle in organization_id or other fields the
// review flow doesn't own.
export const ALLOWED_FIELDS: Record<SuggestionTargetType, string[]> = {
  objective: ["title", "description", "status", "priority"],
  initiative: ["objectiveId", "title", "description", "status", "priority"],
  project: ["initiativeId", "title", "description", "status"],
  task: ["projectId", "title", "description", "status", "latestUpdate", "nextAction"],
  decision: [
    "title",
    "whyItMatters",
    "relevantContext",
    "suggestedNextStep",
    "decider",
    "stakeholders",
    "dueDate",
    "relatedTaskId",
  ],
};

// Exported so the interpretation pipeline can sanitize a model-authored diff
// against the same whitelist this module enforces at apply time -- one source
// of truth for what each target type may set.
export function pickAllowedFields(targetType: SuggestionTargetType, diff: Record<string, unknown>) {
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

    const targetType = suggestion.targetType as SuggestionTargetType;
    const fields = pickAllowedFields(targetType, suggestion.proposedDiff as Record<string, unknown>);

    let resultTargetId: string;

    if (targetType === "decision") {
      const diff = fields as {
        title?: string;
        whyItMatters?: string;
        relevantContext?: string;
        suggestedNextStep?: string;
        decider?: string;
        stakeholders?: string[];
        dueDate?: string;
        relatedTaskId?: string;
      };

      if (suggestion.targetId === null) {
        // Delegating to createDecision (rather than a generic insert here) keeps
        // its org-scoped relatedTaskId/sourceId validation and decision.created
        // audit_log write as the single source of truth for decision creation;
        // duplicating that logic here would let this path silently drift out of
        // sync with the manual POST /api/decisions route.
        if (!diff.title || !diff.decider) {
          throw new SuggestionApplyError("Decision suggestion is missing a required title or decider");
        }

        const decision = await createDecision(tx, {
          organizationId: params.organizationId,
          actorId: params.reviewerId,
          title: diff.title,
          whyItMatters: diff.whyItMatters ?? null,
          relevantContext: diff.relevantContext ?? null,
          suggestedNextStep: diff.suggestedNextStep ?? null,
          decider: diff.decider,
          stakeholders: diff.stakeholders ?? [],
          dueDate: diff.dueDate ? new Date(diff.dueDate) : null,
          relatedTaskId: diff.relatedTaskId ?? null,
          // Cited from the suggestion's own row, not the model-authored diff --
          // ALLOWED_FIELDS deliberately excludes sourceId, since the suggestion
          // already carries the real source it came from.
          sourceId: suggestion.sourceId,
        });
        resultTargetId = decision.id;
      } else {
        // A decision-shaped follow-up matched to an already-open decision (see
        // interpret.ts's decision-matching guidance) -- delegates to
        // updateDecision for the same reason the create branch delegates to
        // createDecision: org-scoped validation and its own decision.updated
        // audit_log entry stay owned by decisions/manage.ts. Only fields that
        // were actually present in the (already-whitelisted) diff are passed
        // through, so an update never blanks out decider/stakeholders/etc. that
        // simply weren't part of this change.
        const updateFields: Parameters<typeof updateDecision>[1]["fields"] = {};
        if ("title" in fields) updateFields.title = diff.title;
        if ("whyItMatters" in fields) updateFields.whyItMatters = diff.whyItMatters ?? null;
        if ("relevantContext" in fields) updateFields.relevantContext = diff.relevantContext ?? null;
        if ("suggestedNextStep" in fields) updateFields.suggestedNextStep = diff.suggestedNextStep ?? null;
        if ("decider" in fields) updateFields.decider = diff.decider;
        if ("stakeholders" in fields) updateFields.stakeholders = diff.stakeholders ?? [];
        if ("dueDate" in fields) updateFields.dueDate = diff.dueDate ? new Date(diff.dueDate) : null;
        if ("relatedTaskId" in fields) updateFields.relatedTaskId = diff.relatedTaskId ?? null;

        const decision = await updateDecision(tx, {
          organizationId: params.organizationId,
          decisionId: suggestion.targetId,
          actorId: params.reviewerId,
          fields: updateFields,
        });
        resultTargetId = decision.id;
      }
    } else {
      const table = TABLE_BY_TARGET_TYPE[targetType];

      if (suggestion.targetId) {
        const [updated] = await tx
          .update(table)
          .set({ ...fields, updatedAt: new Date() } as never)
          .where(and(eq(table.id, suggestion.targetId), eq(table.organizationId, params.organizationId)))
          .returning({ id: table.id });

        if (!updated) {
          throw new SuggestionApplyError("Target row not found or not in this organization");
        }
        resultTargetId = updated.id;
      } else {
        const [created] = await tx
          .insert(table)
          .values({ ...fields, organizationId: params.organizationId } as never)
          .returning({ id: table.id });
        resultTargetId = created.id;
      }
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

    // createDecision/updateDecision each already write their own
    // decision.created/decision.updated audit_log entry; logging
    // suggestion.approved here too would double the audit trail for one
    // approval, so this generic entry is skipped for the decision branch.
    if (targetType !== "decision") {
      await tx.insert(auditLog).values({
        organizationId: params.organizationId,
        actorId: params.reviewerId,
        action: "suggestion.approved",
        entityType: targetType,
        entityId: resultTargetId,
        details: { suggestionId: suggestion.id, appliedFields: fields },
      });
    }

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
