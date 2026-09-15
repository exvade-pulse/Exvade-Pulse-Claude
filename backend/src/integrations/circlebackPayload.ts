import { createHash } from "node:crypto";

// Circleback's automation UI lets a user choose which meeting outputs to send
// (title/notes/action items most useful; transcript optional, excerpt-only).
// We don't have real Circleback API docs for this task -- the field name
// variants below are a best-effort guess and MUST be verified against a real
// payload once a live Circleback automation is connected (see README). We only
// extract enough to populate the `sources` row's title/id/date; the full raw
// body is stored verbatim by the caller regardless of what parsing here finds,
// so a field-name miss never loses data.
export interface ParsedCirclebackMeta {
  title: string;
  externalId: string;
  occurredAt: Date;
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
    title: firstString(payload, ["title", "name", "meetingTitle", "meeting_title"]) ?? "Circleback meeting",
    externalId:
      firstString(payload, ["id", "meetingId", "meeting_id", "externalId", "external_id"]) ??
      fallbackExternalId(rawBodyText),
    occurredAt:
      firstDate(payload, [
        "occurredAt",
        "occurred_at",
        "date",
        "startTime",
        "start_time",
        "meetingDate",
        "meeting_date",
      ]) ?? new Date(),
  };
}
