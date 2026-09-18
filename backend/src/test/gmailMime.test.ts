import { describe, expect, it } from "vitest";
import { parseGmailMessage, type GmailMessage } from "../integrations/gmailMime.js";

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

describe("parseGmailMessage", () => {
  it("extracts subject/from/body from a simple non-multipart message", () => {
    const message: GmailMessage = {
      id: "m1",
      internalDate: String(new Date("2026-01-15T12:00:00Z").getTime()),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Subject", value: "Status update" },
          { name: "From", value: "jane@example.com" },
        ],
        body: { data: b64url("Everything is on track.") },
      },
    };

    const result = parseGmailMessage(message);
    expect(result.subject).toBe("Status update");
    expect(result.from).toBe("jane@example.com");
    expect(result.body).toBe("Everything is on track.");
    expect(result.receivedAt).toEqual(new Date("2026-01-15T12:00:00Z"));
  });

  it("prefers a nested text/plain part over text/html in a multipart/alternative message", () => {
    const message: GmailMessage = {
      id: "m2",
      payload: {
        mimeType: "multipart/alternative",
        headers: [{ name: "Subject", value: "Weekly update" }],
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Plain text version.") } },
          { mimeType: "text/html", body: { data: b64url("<p>HTML version.</p>") } },
        ],
      },
    };

    expect(parseGmailMessage(message).body).toBe("Plain text version.");
  });

  it("falls back to a stripped text/html part when no text/plain part exists", () => {
    const message: GmailMessage = {
      id: "m3",
      payload: {
        mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/html", body: { data: b64url("<p>Only <b>HTML</b> here.</p>") } }],
      },
    };

    expect(parseGmailMessage(message).body).toBe("Only HTML here.");
  });

  it("finds text/plain nested arbitrarily deep (multipart/mixed -> multipart/alternative)", () => {
    const message: GmailMessage = {
      id: "m4",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/plain", body: { data: b64url("Deeply nested body.") } }],
          },
          { mimeType: "application/pdf", body: { data: "irrelevant-attachment-data" } },
        ],
      },
    };

    expect(parseGmailMessage(message).body).toBe("Deeply nested body.");
  });

  it("uses sane fallbacks when headers/body are entirely missing", () => {
    const message: GmailMessage = { id: "m5" };
    const result = parseGmailMessage(message);
    expect(result.subject).toBe("(no subject)");
    expect(result.from).toBe("Unknown sender");
    expect(result.body).toBe("(no readable body)");
    expect(result.receivedAt).toBeInstanceOf(Date);
  });

  it("falls back to the Date header when internalDate is absent", () => {
    const message: GmailMessage = {
      id: "m6",
      payload: { headers: [{ name: "Date", value: "2026-03-01T00:00:00Z" }] },
    };
    expect(parseGmailMessage(message).receivedAt).toEqual(new Date("2026-03-01T00:00:00Z"));
  });
});
