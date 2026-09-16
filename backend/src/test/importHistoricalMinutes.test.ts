import { describe, expect, it } from "vitest";
import {
  parseDateFromFilename,
  parseDateFromContent,
  deriveExternalId,
  sortByDateAscending,
  titleFromFilename,
} from "../scripts/importHistoricalMinutes.js";

// Pure-logic coverage only -- see importHistoricalMinutes.ts's own header
// comment and README.md for why this script has no integration test: it's a
// one-time operational tool run against real local .docx/.pdf files outside
// the repo, and mammoth/pdf-parse's own extraction isn't this task's to test.

describe("parseDateFromFilename", () => {
  const cases: Array<[string, string | null]> = [
    ["2025-03-14-team-meeting.docx", "2025-03-14"],
    ["2025_03_14_team_meeting.docx", "2025-03-14"],
    ["03-14-2025 team meeting.pdf", "2025-03-14"],
    ["03.14.2025-team-meeting.docx", "2025-03-14"],
    ["March 14 2026 - Board Sync.docx", "2026-03-14"],
    ["Mar 14, 2026 Board Sync.pdf", "2026-03-14"],
    ["Team Meeting 14 March 2026.docx", "2026-03-14"],
    ["20250314-notes.docx", "2025-03-14"],
    ["minutes_2024.11.02.pdf", "2024-11-02"],
    ["2025-3-4 sync.docx", "2025-03-04"],
    ["team-sync-notes.docx", null],
    ["Q1 2025 Planning Notes.pdf", null],
    ["meeting notes 2025.docx", null],
    ["March 14 - Board Sync.docx", null],
    ["2025-13-45 bad date.docx", null],
  ];

  it.each(cases)("resolves %s -> %s", (filename, expected) => {
    const result = parseDateFromFilename(filename);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      expect(result!.toISOString().slice(0, 10)).toBe(expected);
    }
  });
});

describe("parseDateFromContent", () => {
  it("finds a confident date within the first ~1000 characters", () => {
    const content = "Meeting minutes -- March 14, 2026\n\nAttendees: Sean, Tejas\n\nDiscussed bench rig calibration.";
    const result = parseDateFromContent(content);
    expect(result).not.toBeNull();
    expect(result!.toISOString().slice(0, 10)).toBe("2026-03-14");
  });

  it("returns null when there is no confident date shape in the excerpt", () => {
    expect(parseDateFromContent("Just some regular notes with no date anywhere in them.")).toBeNull();
  });

  it("ignores a date that only appears after the first ~1000 characters", () => {
    const padding = "x".repeat(1100);
    const content = `${padding} Meeting held March 14, 2026.`;
    expect(parseDateFromContent(content)).toBeNull();
  });
});

describe("sortByDateAscending", () => {
  it("sorts oldest first", () => {
    const items = [
      { id: "c", resolvedDate: new Date("2026-03-01") },
      { id: "a", resolvedDate: new Date("2024-01-15") },
      { id: "b", resolvedDate: new Date("2025-06-30") },
    ];
    expect(sortByDateAscending(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const items = [{ id: "b", resolvedDate: new Date("2026-01-01") }, { id: "a", resolvedDate: new Date("2024-01-01") }];
    const original = [...items];
    sortByDateAscending(items);
    expect(items).toEqual(original);
  });

  it("is stable for equal dates", () => {
    const sameDate = new Date("2025-01-01");
    const items = [
      { id: "first", resolvedDate: sameDate },
      { id: "second", resolvedDate: sameDate },
    ];
    expect(sortByDateAscending(items).map((i) => i.id)).toEqual(["first", "second"]);
  });
});

describe("deriveExternalId", () => {
  it("is stable across calls for the same path", () => {
    const path = String.raw`C:\Users\meeha\Documents\ExvadePulse-Import\2025-03-14-team-meeting.docx`;
    expect(deriveExternalId(path)).toBe(deriveExternalId(path));
  });

  it("differs for different paths", () => {
    const a = String.raw`C:\Users\meeha\Documents\ExvadePulse-Import\2025-03-14-team-meeting.docx`;
    const b = String.raw`C:\Users\meeha\Documents\ExvadePulse-Import\2025-03-15-team-meeting.docx`;
    expect(deriveExternalId(a)).not.toBe(deriveExternalId(b));
  });

  it("is stable across path casing (Windows filesystems are case-insensitive)", () => {
    const lower = String.raw`C:\users\meeha\documents\exvadepulse-import\notes.docx`;
    const upper = String.raw`C:\Users\Meeha\Documents\ExvadePulse-Import\Notes.docx`;
    expect(deriveExternalId(lower)).toBe(deriveExternalId(upper));
  });
});

describe("titleFromFilename", () => {
  it("strips the extension and cleans up underscores", () => {
    expect(titleFromFilename("2025_03_14_team_meeting.docx")).toBe("2025 03 14 team meeting");
  });

  it("leaves hyphenated filenames mostly intact", () => {
    expect(titleFromFilename("2025-03-14-team-meeting.pdf")).toBe("2025-03-14-team-meeting");
  });
});
