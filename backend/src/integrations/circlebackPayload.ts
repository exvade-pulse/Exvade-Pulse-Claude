import { createHash } from "node:crypto";

// Verified against a real Circleback delivery (see README): the actual field
// names are `name` (title), `id` (external id), `createdAt` (date), `notes`,
// and `actionItems` (an array of {title, description, assignee: {name,
// email}, status}). The extra guessed variants below are kept as a fallback
// for the fields that did match a real payload on the first name tried, in
// case Circleback's shape varies by automation/output configuration --
// they're unverified, not a "this is definitely wrong" signal.
export interface ParsedCirclebackMeta {
  title: string;
  externalId: string;
  occurredAt: Date;
  // Extracted notes + formatted action items, not the full raw JSON --
  // matches emailPayload.ts's approach (extract the substantive content,
  // not dump the whole envelope). A real payload's `notes` are the actual
  // meeting summary; the surrounding JSON (attendees, tags, a recording URL
  // that itself expires in 24h) isn't worth interpretation reading through
  // or storing long-term. Falls back to the full raw JSON when neither notes
  // nor actionItems parse out, so a shape we don't recognize still keeps
  // something to interpret rather than an empty body.
  body: string;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function firstDate(obj: Record<string, unknown>, keys: string[]): Date | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

// Falls back to a hash of the raw body rather than failing ingestion outright
// -- a source with no recognizable id is still worth keeping and interpreting.
function fallbackExternalId(rawBodyText: string): string {
  return `circleback-${createHash("sha256").update(rawBodyText).digest("hex").slice(0, 24)}`;
}

interface CirclebackActionItem {
  title?: string;
  description?: string;
  assignee?: { name?: string; email?: string };
  status?: string;
}

// Handles both the real shape (an array of {title, description, assignee,
// status} objects) and a plain array of strings -- not a shape we've seen
// from a real delivery, but a simpler automation config plausibly sends one,
// and there's no reason to silently drop an item just because it's a string
// rather than an object.
function formatActionItems(items: unknown): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const lines: string[] = [];
  for (const raw of items as unknown[]) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      lines.push(`- ${raw}`);
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const item = raw as CirclebackActionItem;
    if (!item.title) continue;
    const assigneeName = item.assignee && typeof item.assignee === "object" ? item.assignee.name : undefined;
    let line = `- ${item.title}`;
    if (assigneeName) line += ` (${assigneeName})`;
    if (item.status) line += ` [${item.status}]`;
    if (item.description) line += `: ${item.description}`;
    lines.push(line);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function extractBody(payload: Record<string, unknown>, rawBodyText: string): string {
  const notes = firstString(payload, ["notes", "summary"]);
  const actionItems = formatActionItems(payload.actionItems ?? (payload as { action_items?: unknown }).action_items);

  const parts = [notes, actionItems ? `Action items:\n${actionItems}` : undefined].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join("\n\n") : rawBodyText;
}

export function parseCirclebackMeta(rawBodyText: string): ParsedCirclebackMeta {
  let payload: Record<string, unknown> = {};
  try {
    const decoded: unknown = JSON.parse(rawBodyText);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      payload = decoded as Record<string, unknown>;
    }
  } catch {
    // Not valid JSON -- proceed with an empty payload; the exact raw text is
    // still preserved verbatim as sources.rawBody by the caller.
  }

  return {
    title: firstString(payload, ["name", "title", "meetingTitle", "meeting_title"]) ?? "Circleback meeting",
    externalId:
      firstString(payload, ["id", "meetingId", "meeting_id", "externalId", "external_id"]) ??
      fallbackExternalId(rawBodyText),
    occurredAt:
      firstDate(payload, [
        "createdAt",
        "created_at",
        "occurredAt",
        "occurred_at",
        "date",
        "startTime",
        "start_time",
        "meetingDate",
        "meeting_date",
      ]) ?? new Date(),
    body: extractBody(payload, rawBodyText),
  };
}
