// Gmail's API already parses MIME into a JSON tree (unlike a raw webhook
// payload, there's no envelope format to guess at) -- this just walks that
// tree for the pieces the interpretation pipeline needs.

export interface GmailMessagePart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function headerValue(headers: Array<{ name: string; value: string }> | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

// Depth-first search for the first part matching a mimeType, since a
// multipart/alternative or multipart/mixed message nests the actual text
// arbitrarily deep (e.g. multipart/mixed -> multipart/alternative ->
// text/plain, once an attachment is present).
function findPart(part: GmailMessagePart | undefined, mimeType: string): GmailMessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export interface ParsedGmailMessage {
  subject: string;
  from: string;
  body: string;
  receivedAt: Date;
}

// Prefers text/plain; falls back to a crude-stripped text/html; falls back
// to the top-level body directly for a genuinely non-multipart message
// (mimeType text/plain at the root, no parts array at all).
export function parseGmailMessage(message: GmailMessage): ParsedGmailMessage {
  const headers = message.payload?.headers;
  const subject = headerValue(headers, "Subject") ?? "(no subject)";
  const from = headerValue(headers, "From") ?? "Unknown sender";

  const plainPart = findPart(message.payload, "text/plain");
  const htmlPart = findPart(message.payload, "text/html");

  let body: string;
  if (plainPart?.body?.data) {
    body = decodeBase64Url(plainPart.body.data);
  } else if (htmlPart?.body?.data) {
    body = stripHtml(decodeBase64Url(htmlPart.body.data));
  } else if (message.payload?.body?.data) {
    body = decodeBase64Url(message.payload.body.data);
  } else {
    body = "(no readable body)";
  }

  // internalDate is epoch milliseconds as a string; the Date header is a
  // reasonable fallback but internalDate is what Gmail itself recorded on
  // receipt, so it's preferred when present.
  const receivedAt = message.internalDate
    ? new Date(Number(message.internalDate))
    : new Date(headerValue(headers, "Date") ?? Date.now());

  return { subject, from, body, receivedAt };
}
