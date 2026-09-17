import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { auditLog, suggestions } from "../db/schema.js";
import type { SuggestionDraft } from "../interpretation/fakeInterpret.js";

export interface MergeOrInsertParams {
  organizationId: string;
  sourceId: string;
  sourceReceivedAt: Date;
  draft: SuggestionDraft;
}

export interface MergeOrInsertResult {
  id: string;
  merged: boolean;
}

// A newer source describing the same already-tracked entity shouldn't spawn
// a second review card next to a suggestion still awaiting a decision --
// that's duplicate work for the reviewer, and if the two were later approved
// separately, a race for which write actually wins. When a pending/edited
// suggestion already targets the exact same (targetType, targetId), this
// enriches that row in place instead of inserting a new one:
//   - proposedDiff fields merge shallowly -- the newer draft's values win on
//     any overlapping key, but a field only the older draft (or a human's
//     prior hand-edit) set is preserved, not discarded.
//   - reasoning is appended to, not replaced, so neither source's rationale
//     is lost -- a reviewer can still see why the original suggestion was
//     made, not just the latest one.
//   - confidence takes the newer draft's read.
//   - sourceId moves to the newest source, consistent with this app's
//     general newer-evidence-precedence principle -- the "View source"
//     toggle then shows the most recent citation.
//   - status is left exactly as it was (pending stays pending, edited stays
//     edited): enrichment isn't a review decision, and forcing an in-progress
//     hand-edit back to "pending" isn't this function's call to make.
// Only ever applies when draft.targetId is set -- a new_task/new-entity
// draft (targetId null) has nothing existing to merge into by definition.
export async function mergeOrInsertSuggestion(
  tx: DbOrTx,
  params: MergeOrInsertParams,
): Promise<MergeOrInsertResult> {
  const { organizationId, sourceId, sourceReceivedAt, draft } = params;

  if (draft.targetId !== null) {
    const [existing] = await tx
      .select()
      .from(suggestions)
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.targetType, draft.targetType),
          eq(suggestions.targetId, draft.targetId),
          inArray(suggestions.status, ["pending", "edited"]),
        ),
      )
      .orderBy(desc(suggestions.createdAt))
      .limit(1);

    if (existing) {
      const mergedDiff = { ...(existing.proposedDiff as Record<string, unknown>), ...draft.proposedDiff };
      const mergedReasoning = `${existing.reasoning}\n\n[Enriched by a newer source received ${sourceReceivedAt.toISOString().slice(0, 10)}]: ${draft.reasoning}`;

      const [updated] = await tx
        .update(suggestions)
        .set({
          sourceId,
          proposedDiff: mergedDiff,
          reasoning: mergedReasoning,
          confidence: draft.confidence,
        })
        .where(eq(suggestions.id, existing.id))
        .returning();

      // No actor -- this happens as a side effect of ingestion, not a human
      // action, same as suggestion creation itself is never audit-logged.
      await tx.insert(auditLog).values({
        organizationId,
        actorId: null,
        action: "suggestion.enriched",
        entityType: draft.targetType,
        entityId: draft.targetId,
        details: { suggestionId: existing.id, previousSourceId: existing.sourceId, newSourceId: sourceId },
      });

      return { id: updated.id, merged: true };
    }
  }

  const [inserted] = await tx
    .insert(suggestions)
    .values({
      organizationId,
      sourceId,
      targetType: draft.targetType,
      targetId: draft.targetId,
      changeType: draft.changeType,
      proposedDiff: draft.proposedDiff,
      reasoning: draft.reasoning,
      confidence: draft.confidence,
    })
    .returning();

  return { id: inserted.id, merged: false };
}
