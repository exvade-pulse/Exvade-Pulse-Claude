import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { auditLog, initiatives, objectives, projects, sources, suggestions, tasks, type EntityNodeType, type RelationType } from "../db/schema.js";
import { createDecision, updateDecision } from "../decisions/manage.js";
import { createRelationship, RelationshipError } from "../relationships/manage.js";

export class SuggestionApplyError extends Error {}

const TABLE_BY_TARGET_TYPE = {
  objective: objectives,
  initiative: initiatives,
  project: projects,
  task: tasks,
} as const;

// The task fields worth tracking "when was this actually last confirmed, and
// by what source" for -- see schema.ts's tasks.fieldEvidence comment. title/
// description are more structural/narrative than "current operational fact",
// so they're deliberately left out of v1.
const TRACKED_EVIDENCE_FIELDS = ["status", "latestUpdate", "nextAction", "owner"] as const;

// Fields a brand-new row of each type cannot be created without -- a real
// parent id (except objective, which has none) plus a title. interpret.ts's
// SYSTEM_PROMPT already instructs the model to always include the parent id,
// but that's prompt guidance, not enforcement: a malformed draft (parent id
// omitted) previously reached the database uncaught, where the table's own
// NOT NULL constraint rejected it with a raw, unhandled Postgres error --
// crashing the whole request (including the rest of a bulk-approve batch)
// instead of failing this one suggestion gracefully. Checked below before
// ever attempting the insert.
// Exported so interpret.ts's validateSuggestionInput can reject a malformed
// new-entity draft at ingestion time too -- catching it here (apply.ts) is
// what stops the crash, but rejecting it before it's ever stored as a
// suggestion is better still, since a suggestion missing required fields can
// never actually be approved no matter how many times it's retried.
export const REQUIRED_CREATE_FIELDS: Record<Exclude<SuggestionTargetType, "decision" | "relationship">, string[]> = {
  objective: ["title"],
  initiative: ["objectiveId", "title"],
  project: ["initiativeId", "title"],
  task: ["projectId", "title"],
};

// "decision" and "relationship" are valid suggestion targetTypes but
// deliberately have no entry in TABLE_BY_TARGET_TYPE: neither is a drop-in
// "insert this table with whitelisted fields" case like the other four --
// decision needs org-scoped relatedTaskId/sourceId validation and its own
// audit_log entry (decisions/manage.ts's createDecision), and relationship
// needs both-endpoints-exist validation with no single row to update
// (relationships/manage.ts's createRelationship) -- so each is handled as
// its own branch in approveSuggestion instead. ALLOWED_FIELDS/
// pickAllowedFields still cover both, since interpret.ts's sanitization step
// whitelists every targetType the model may propose.
export type SuggestionTargetType = keyof typeof TABLE_BY_TARGET_TYPE | "decision" | "relationship";

// Whitelists what a proposed_diff may set on each target type, so an AI-authored
// (or hand-edited) diff can never smuggle in organization_id or other fields the
// review flow doesn't own.
// "owner" is deliberately only on these four hierarchy types, not "decision":
// decisions already have their own decider/stakeholders fields for "who's
// responsible", and this is a single free-text field (not a stakeholders
// array) by scope decision -- see the comment on schema.ts's owner columns.
export const ALLOWED_FIELDS: Record<SuggestionTargetType, string[]> = {
  objective: ["title", "description", "status", "priority", "owner"],
  initiative: ["objectiveId", "title", "description", "status", "priority", "owner"],
  project: ["initiativeId", "title", "description", "status", "owner"],
  task: ["projectId", "title", "description", "status", "latestUpdate", "nextAction", "owner"],
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
  relationship: ["fromType", "fromId", "toType", "toId", "relationType", "note"],
};

// Fields a "context" (Info Share) suggestion may touch on the four hierarchy
// types -- deliberately excludes every current-state field (status,
// latestUpdate, nextAction, priority) so approving one can only add
// background, never silently become the entity's current operational state.
// "decision" is not in this map: it has its own changeType vocabulary and a
// dedicated relevantContext field, so this restriction doesn't apply to it.
const CONTEXT_ONLY_FIELDS: Partial<Record<SuggestionTargetType, string[]>> = {
  objective: ["description", "owner"],
  initiative: ["description", "owner"],
  project: ["description", "owner"],
  task: ["description", "owner"],
};

// Exported so the interpretation pipeline can sanitize a model-authored diff
// against the same whitelist this module enforces at apply time -- one source
// of truth for what each target type may set. changeType narrows the
// whitelist further for "context": see CONTEXT_ONLY_FIELDS above.
export function pickAllowedFields(
  targetType: SuggestionTargetType,
  changeType: string,
  diff: Record<string, unknown>,
) {
  const contextFields = changeType === "context" ? CONTEXT_ONLY_FIELDS[targetType] : undefined;
  const allowed = contextFields ?? ALLOWED_FIELDS[targetType];
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
    const fields = pickAllowedFields(
      targetType,
      suggestion.changeType,
      suggestion.proposedDiff as Record<string, unknown>,
    );

    let resultTargetId: string;

    if (targetType === "relationship") {
      // Always a create (targetId is never set for a relationship draft --
      // see interpret.ts/relationshipDetection.ts, there's no single existing
      // row to "update", both endpoints live in the diff itself).
      // createRelationship already does the org-scoped existence check on
      // both sides and rejects a self-link -- translate its own error type
      // into SuggestionApplyError so a stale or malformed proposal (e.g. one
      // endpoint deleted since this was proposed) fails this one suggestion
      // gracefully instead of crashing the request, same lesson as
      // REQUIRED_CREATE_FIELDS below for the four hierarchy types.
      const diff = fields as {
        fromType?: EntityNodeType;
        fromId?: string;
        toType?: EntityNodeType;
        toId?: string;
        relationType?: RelationType;
        note?: string;
      };
      if (!diff.fromType || !diff.fromId || !diff.toType || !diff.toId || !diff.relationType) {
        throw new SuggestionApplyError("Relationship suggestion is missing a required field");
      }

      try {
        const relationship = await createRelationship(tx, {
          organizationId: params.organizationId,
          actorId: params.reviewerId,
          fromType: diff.fromType,
          fromId: diff.fromId,
          toType: diff.toType,
          toId: diff.toId,
          relationType: diff.relationType,
          note: diff.note ?? null,
        });
        resultTargetId = relationship.id;
      } catch (err) {
        if (err instanceof RelationshipError) {
          throw new SuggestionApplyError(err.message);
        }
        throw err;
      }
    } else if (targetType === "decision") {
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

      // Only tasks track fieldEvidence (see schema.ts) -- build the patch for
      // whichever tracked fields this diff actually touches, so an
      // operational_update that only sets status doesn't disturb the
      // latestUpdate/nextAction/owner evidence already on record.
      let evidencePatch: Record<string, { asOf: string; sourceId: string }> | null = null;
      if (targetType === "task") {
        const trackedKeys = TRACKED_EVIDENCE_FIELDS.filter((key) => key in fields);
        if (trackedKeys.length > 0) {
          const [source] = await tx
            .select({ receivedAt: sources.receivedAt })
            .from(sources)
            .where(eq(sources.id, suggestion.sourceId));
          const asOf = (source?.receivedAt ?? suggestion.createdAt).toISOString();
          evidencePatch = {};
          for (const key of trackedKeys) {
            evidencePatch[key] = { asOf, sourceId: suggestion.sourceId };
          }
        }
      }

      if (suggestion.targetId) {
        const setClause: Record<string, unknown> = { ...fields, updatedAt: new Date() };
        if (evidencePatch) {
          // Shallow-merge into whatever evidence already exists (jsonb ||
          // overwrites only the top-level keys present on the right side),
          // computed server-side in the same update rather than a separate
          // read-then-write.
          setClause.fieldEvidence = sql`COALESCE(${tasks.fieldEvidence}, '{}'::jsonb) || ${JSON.stringify(evidencePatch)}::jsonb`;
        }

        const [updated] = await tx
          .update(table)
          .set(setClause as never)
          .where(and(eq(table.id, suggestion.targetId), eq(table.organizationId, params.organizationId)))
          .returning({ id: table.id });

        if (!updated) {
          throw new SuggestionApplyError("Target row not found or not in this organization");
        }
        resultTargetId = updated.id;
      } else {
        const missing = REQUIRED_CREATE_FIELDS[targetType].filter((key) => !(key in fields));
        if (missing.length > 0) {
          throw new SuggestionApplyError(
            `Cannot create a new ${targetType}: missing required field(s) ${missing.join(", ")}`,
          );
        }

        const insertValues: Record<string, unknown> = { ...fields, organizationId: params.organizationId };
        if (evidencePatch) {
          insertValues.fieldEvidence = evidencePatch;
        }

        const [created] = await tx
          .insert(table)
          .values(insertValues as never)
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
    const sanitized = pickAllowedFields(targetType, suggestion.changeType, merged);

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
