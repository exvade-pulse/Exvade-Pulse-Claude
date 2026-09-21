import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { auditLog, suggestions, tasks } from "../db/schema.js";
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

export interface ConflictEntry {
  field: string;
  proposedValue: unknown;
  proposedSourceId: string;
  proposedAsOf: string;
  currentValue: unknown;
  currentAsOf: string;
}

interface FieldEvidenceEntry {
  asOf: string;
  sourceId: string;
}

// Same tracked-field set as apply.ts's TRACKED_EVIDENCE_FIELDS -- kept as a
// separate constant (not imported) since apply.ts and dedupe.ts each have
// their own reason to know it and importing across suggestions/ modules for
// one array isn't worth the coupling.
const TRACKED_EVIDENCE_FIELDS = ["status", "latestUpdate", "nextAction", "owner"] as const;

// Strips any field from draft.proposedDiff whose evidence is genuinely older
// than what's already confirmed on the live task (tasks.fieldEvidence), and
// returns both the cleaned diff and a conflict entry per stripped field.
// Never fabricates a conflict for a field the task has no prior evidence
// for -- only a real regression (older source, different value already on
// record) counts. Only ever runs for an update to an existing task; a
// new_task draft (targetId null) has nothing existing to conflict with.
async function stripConflictingFields(
  tx: DbOrTx,
  organizationId: string,
  draft: SuggestionDraft,
  sourceId: string,
  sourceReceivedAt: Date,
): Promise<{ cleanedDiff: Record<string, unknown>; conflicts: ConflictEntry[] }> {
  if (draft.targetType !== "task" || draft.targetId === null) {
    return { cleanedDiff: draft.proposedDiff, conflicts: [] };
  }

  const [task] = await tx
    .select({
      status: tasks.status,
      latestUpdate: tasks.latestUpdate,
      nextAction: tasks.nextAction,
      owner: tasks.owner,
      fieldEvidence: tasks.fieldEvidence,
    })
    .from(tasks)
    .where(and(eq(tasks.id, draft.targetId), eq(tasks.organizationId, organizationId)));

  const evidence = (task?.fieldEvidence ?? null) as Record<string, FieldEvidenceEntry> | null;
  if (!task || !evidence) {
    return { cleanedDiff: draft.proposedDiff, conflicts: [] };
  }

  const cleanedDiff = { ...draft.proposedDiff };
  const conflicts: ConflictEntry[] = [];

  for (const field of TRACKED_EVIDENCE_FIELDS) {
    if (!(field in cleanedDiff)) continue;
    const fieldEvidence = evidence[field];
    if (!fieldEvidence) continue; // never confirmed before -- nothing to regress
    if (sourceReceivedAt.getTime() >= new Date(fieldEvidence.asOf).getTime()) continue; // as-new-or-newer -- fine

    conflicts.push({
      field,
      proposedValue: cleanedDiff[field],
      proposedSourceId: sourceId,
      proposedAsOf: sourceReceivedAt.toISOString(),
      currentValue: (task as Record<string, unknown>)[field] ?? null,
      currentAsOf: fieldEvidence.asOf,
    });
    delete cleanedDiff[field];
  }

  return { cleanedDiff, conflicts };
}

// Merges a fresh conflict list into whatever conflicts already sit on a
// pending suggestion, keyed by field so a repeat conflict on the same field
// replaces (rather than duplicates) the earlier entry -- same
// newer-evidence-precedence principle the rest of this function already
// follows for proposedDiff/reasoning/confidence.
function mergeConflicts(existing: ConflictEntry[] | null, fresh: ConflictEntry[]): ConflictEntry[] | null {
  if (fresh.length === 0) return existing ?? null;
  const byField = new Map<string, ConflictEntry>();
  for (const c of existing ?? []) byField.set(c.field, c);
  for (const c of fresh) byField.set(c.field, c);
  return [...byField.values()];
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

  // A draft proposing a task field that's already been confirmed by a more
  // recent source (tasks.fieldEvidence) has that field stripped before it
  // ever reaches proposedDiff -- see stripConflictingFields. This runs
  // before the merge/insert split below so both paths see the already-clean
  // diff and the same conflict list.
  const { cleanedDiff, conflicts: newConflicts } = await stripConflictingFields(
    tx,
    organizationId,
    draft,
    sourceId,
    sourceReceivedAt,
  );

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
      const mergedDiff = { ...(existing.proposedDiff as Record<string, unknown>), ...cleanedDiff };
      const mergedReasoning = `${existing.reasoning}\n\n[Enriched by a newer source received ${sourceReceivedAt.toISOString().slice(0, 10)}]: ${draft.reasoning}`;
      const mergedConflicts = mergeConflicts(existing.conflicts as ConflictEntry[] | null, newConflicts);

      const [updated] = await tx
        .update(suggestions)
        .set({
          sourceId,
          proposedDiff: mergedDiff,
          reasoning: mergedReasoning,
          confidence: draft.confidence,
          conflicts: mergedConflicts,
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
      proposedDiff: cleanedDiff,
      reasoning: draft.reasoning,
      confidence: draft.confidence,
      conflicts: newConflicts.length > 0 ? newConflicts : null,
    })
    .returning();

  return { id: inserted.id, merged: false };
}
