import type { Database } from "../db/client.js";
import type { EntityNodeType } from "../db/schema.js";
import { resolveNames } from "../relationships/manage.js";

interface DescribableSuggestion {
  id: string;
  targetType: string;
  targetId: string | null;
  proposedDiff: unknown;
  changeType?: string;
}

// A plain-language name for what each suggestion is about ("Order sensor
// harness", "New task: Call the vendor", "A depends_on B") -- a raw id means
// nothing to a reader outside the app. Existing targets and relationship
// endpoints resolve in one batched lookup; a brand-new entity's name is its
// proposed title.
export async function describeSuggestions(
  db: Database,
  organizationId: string,
  rows: DescribableSuggestion[],
): Promise<Map<string, string>> {
  const refs: Array<{ type: EntityNodeType; id: string }> = [];
  for (const row of rows) {
    const diff = row.proposedDiff as Record<string, unknown>;
    if (row.targetType === "relationship") {
      if (typeof diff.fromId === "string") refs.push({ type: diff.fromType as EntityNodeType, id: diff.fromId });
      if (typeof diff.toId === "string") refs.push({ type: diff.toType as EntityNodeType, id: diff.toId });
    } else if (row.targetId && row.targetType !== "question") {
      refs.push({ type: row.targetType as EntityNodeType, id: row.targetId });
      if (row.changeType === "merge" && typeof diff.supersededById === "string") {
        refs.push({ type: row.targetType as EntityNodeType, id: diff.supersededById });
      }
    }
  }
  const names = await resolveNames(db, organizationId, refs);
  const nameOf = (type: unknown, id: unknown) => names.get(`${String(type)}:${String(id)}`) ?? "(unknown)";

  const result = new Map<string, string>();
  for (const row of rows) {
    const diff = row.proposedDiff as Record<string, unknown>;
    const about =
      row.targetType === "question"
        ? `Strategic question: ${String(diff.title ?? "(untitled)")}`
        : row.targetType === "relationship"
        ? `${nameOf(diff.fromType, diff.fromId)} ${String(diff.relationType)} ${nameOf(diff.toType, diff.toId)}`
        : row.changeType === "merge" && row.targetId
          ? `Merge duplicate ${row.targetType} "${nameOf(row.targetType, row.targetId)}" into "${nameOf(row.targetType, diff.supersededById)}"`
          : row.changeType === "replace" && row.targetId
          ? `Replace "${nameOf(row.targetType, row.targetId)}" with new task "${String((diff.newTask as { title?: unknown } | undefined)?.title ?? "(untitled)")}"`
          : row.changeType === "cleanup" && row.targetId
          ? `Cleanup: ${nameOf(row.targetType, row.targetId)}`
          : row.targetId
          ? nameOf(row.targetType, row.targetId)
          : `New ${row.targetType}: ${String(diff.title ?? "(untitled)")}`;
    result.set(row.id, about);
  }
  return result;
}
