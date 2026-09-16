import { createHash } from "node:crypto";

// No inbound-email provider is actually connected yet, so this targets
// Postmark's documented inbound-webhook JSON shape as a concrete, common
// choice ("forward mail to an address, get a JSON webhook") absent a chosen
// provider. We don't have official Postmark reference docs loaded for this
// task -- the field name variants below (From/FromFull/Subject/TextBody/
// HtmlBody/MessageID/Date) are a best-effort guess from general knowledge of
// that shape and MUST be verified against a real delivery once a live
// provider is connected (see README), the same honest hedge
// circlebackPayload.ts carries for Circleback's fields. The full raw JSON is
// always what the caller stores as sources.rawBody regardless of what
// parsing here finds, so a field-name miss never loses the original.
export interface ParsedEmailMeta {
  subject: string;
  from: string;
  body: string;
  externalId: string;
  receivedAt: Date;
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

function nestedObject(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

// Falls back to a hash of the raw body rather than failing ingestion outright
// -- a source with no recognizable id is still worth keeping and interpreting.
function fallbackExternalId(rawBodyText: string): string {
  return `email-${createHash("sha256").update(rawBodyText).digest("hex").slice(0, 24)}`;
}

// Deliberately crude -- a regex tag-strip, not real HTML-to-text conversion.
// Good enough to give the interpretation pass readable text when TextBody is
// missing; not meant to preserve structure or handle malformed markup.
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractSender(payload: Record<string, unknown>): string {
  const fromFull = nestedObject(payload, ["FromFull", "fromFull", "from_full"]);
  if (fromFull) {
    const email = firstString(fromFull, ["Email", "email"]);
    const name = firstString(fromFull, ["Name", "name"]);
    if (email && name) return `${name} <${email}>`;
    if (email) return email;
  }
  return firstString(payload, ["From", "from", "Sender", "sender"]) ?? "Unknown sender";
}

// Prefers TextBody; falls back to a stripped HtmlBody; and if neither
// field-name guess lands, falls back to the full raw JSON text rather than
// an empty string, so field-parsing missing the body never means losing the
// content entirely -- the same "never lose the original" principle
// circlebackPayload.ts documents, just applied one level deeper here since
// (unlike Circleback's payload) an email's raw JSON envelope is mostly
// headers/HTML noise around the part actually worth interpreting.
function extractBody(payload: Record<string, unknown>, rawBodyText: string): string {
  const text = firstString(payload, ["TextBody", "text_body", "textBody", "StrippedTextReply"]);
  if (text) return text;
  const html = firstString(payload, ["HtmlBody", "html_body", "htmlBody"]);
  if (html) return stripHtml(html);
  return rawBodyText;
}

export function parseEmailMeta(rawBodyText: string): ParsedEmailMeta {
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
    subject: firstString(payload, ["Subject", "subject"]) ?? "(no subject)",
    from: extractSender(payload),
    body: extractBody(payload, rawBodyText),
    externalId:
      firstString(payload, ["MessageID", "MessageId", "message_id", "messageId"]) ??
      fallbackExternalId(rawBodyText),
    receivedAt: firstDate(payload, ["Date", "date", "ReceivedAt", "received_at"]) ?? new Date(),
  };
}
