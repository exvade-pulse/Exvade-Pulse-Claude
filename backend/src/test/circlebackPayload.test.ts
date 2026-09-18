import { describe, expect, it } from "vitest";
import { parseCirclebackMeta } from "../integrations/circlebackPayload.js";

describe("parseCirclebackMeta", () => {
  it("parses a real Circleback payload shape correctly (verified against a live delivery)", () => {
    const payload = JSON.stringify({
      id: "QbRTjv21RSdx8KA1jUGca",
      name: "TMD Update",
      createdAt: "2026-09-16T14:31:39.034Z",
      notes: "#### Overview\n* Some meeting notes here.",
      actionItems: [
        {
          id: 1,
          title: "Send Stevie a list of data points",
          description: "Needed to update the checklist.",
          assignee: { name: "Nassir Mokarram", email: "n.mokarram@gmail.com" },
          status: "PENDING",
        },
      ],
    });

    const meta = parseCirclebackMeta(payload);
    expect(meta.title).toBe("TMD Update");
    expect(meta.externalId).toBe("QbRTjv21RSdx8KA1jUGca");
    expect(meta.occurredAt).toEqual(new Date("2026-09-16T14:31:39.034Z"));
    expect(meta.body).toContain("Some meeting notes here.");
    expect(meta.body).toContain("Send Stevie a list of data points (Nassir Mokarram) [PENDING]: Needed to update the checklist.");
    // The recording URL / attendees / tags / icalUid envelope is not in the
    // extracted body -- only notes + action items are.
    expect(meta.body).not.toContain("recordingUrl");
  });

  it("prefers createdAt over other date field guesses when both are present", () => {
    const payload = JSON.stringify({ name: "x", id: "1", createdAt: "2026-01-01T00:00:00Z", occurredAt: "2026-06-01T00:00:00Z" });
    expect(parseCirclebackMeta(payload).occurredAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("falls back through the date guess list when createdAt is absent", () => {
    const payload = JSON.stringify({ name: "x", id: "1", startTime: "2026-03-01T00:00:00Z" });
    expect(parseCirclebackMeta(payload).occurredAt).toEqual(new Date("2026-03-01T00:00:00Z"));
  });

  it("handles actionItems as a plain array of strings, not just objects", () => {
    const payload = JSON.stringify({ name: "x", id: "1", notes: "Notes here.", actionItems: ["Recalibrate rig #3 by Friday"] });
    expect(parseCirclebackMeta(payload).body).toContain("Recalibrate rig #3 by Friday");
  });

  it("falls back to the full raw JSON body when neither notes nor actionItems parse out", () => {
    const payload = JSON.stringify({ someUnexpectedShape: true, blob: "unstructured content" });
    const meta = parseCirclebackMeta(payload);
    expect(meta.body).toContain("unstructured content");
  });

  it("falls back to a hash-based externalId and a default title for unparseable JSON", () => {
    const meta = parseCirclebackMeta("not valid json at all");
    expect(meta.title).toBe("Circleback meeting");
    expect(meta.externalId).toMatch(/^circleback-[0-9a-f]{24}$/);
    expect(meta.body).toBe("not valid json at all");
  });

  it("still finds title/id via the older guessed field names when name/id aren't present", () => {
    const payload = JSON.stringify({ title: "Weekly sync", meetingId: "m-123", notes: "Standup notes." });
    const meta = parseCirclebackMeta(payload);
    expect(meta.title).toBe("Weekly sync");
    expect(meta.externalId).toBe("m-123");
  });
});
