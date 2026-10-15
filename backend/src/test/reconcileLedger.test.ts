import { describe, expect, it } from "vitest";
import { normalizeTitle, parseCsv, reconcileLedger, reportCsv, type ExportTask } from "../reconcile/ledger.js";

const task = (id: string, title: string, over: Partial<ExportTask> = {}): ExportTask => ({
  id,
  title,
  status: "active",
  outcome: "Sampling",
  project: "Bench",
  supersededById: null,
  ...over,
});

describe("reconcileLedger", () => {
  const tasks = [
    task("t1", "Needle size testing (19G/16G/18G)"),
    task("t2", "Needle size testing (dome sampling)"),
    task("t3", "Aspirate sample analysis - low-volume cfDNA / single-cell assay feasibility"),
    task("t4", "Aspirate sample analysis – low-volume cfDNA / single-cell assay feasibility", { supersededById: "t3" }),
    task("t5", "Prep clinical data summary"),
    task("t6", "Prep clinical data summary"),
    task("t7", "Upload cap table", { status: "completed" }),
  ];

  it("matches only exact, unique titles; similar names are candidates, never matches", () => {
    const r = reconcileLedger(
      [
        { id: "L1", task: "needle size testing  (19G/16G/18G)" },
        { id: "L2", task: "Aspirate sample analysis - low-volume cfDNA / single-cell assay feasibility" },
        { id: "L3", task: "Prep clinical data summary" },
        { id: "L4", task: "Needle size testing (dome puncture)" },
        { id: "L5", task: "Something nobody wrote down" },
      ],
      tasks,
    );
    const [l1, l2, l3, l4, l5] = r.matches;
    // Exact after normalizing; the other needle task is flagged as a possible duplicate.
    expect(l1).toMatchObject({ status: "exact_with_possible_duplicates", match: { id: "t1" } });
    expect(l1.possibleDuplicates.map((t) => t.id)).toEqual(["t2"]);
    // A merged-away copy with the same title doesn't make it ambiguous.
    expect(l2).toMatchObject({ status: "exact", match: { id: "t3" } });
    // Two live records with the same title: ambiguous, both listed.
    expect(l3.status).toBe("ambiguous");
    expect(l3.candidates.map((t) => t.id).sort()).toEqual(["t5", "t6"]);
    // Close but not equal: never matched.
    expect(l4).toMatchObject({ status: "ambiguous", match: null });
    expect(l4.candidates.map((t) => t.id)).toContain("t2");
    expect(l5).toMatchObject({ status: "absent", candidates: [] });
    // Live records nobody matched, including completed ones; merged ones aren't listed.
    expect(r.unseen.map((t) => t.id).sort()).toEqual(["t2", "t5", "t6", "t7"]);
    expect(r.counts).toEqual({ exact: 1, exact_with_possible_duplicates: 1, ambiguous: 2, absent: 1, unseen: 4 });
    expect(reportCsv(r).split("\r\n")).toHaveLength(6);
  });

  it("normalizes dashes, quotes, case and spacing only", () => {
    expect(normalizeTitle("  Kessel “quote”  — scale-up ")).toBe('kessel "quote" - scale-up');
  });

  it("parses quoted CSV fields with commas, quotes and line breaks", () => {
    const rows = parseCsv('﻿id,task,note\r\nT1,"A, B","He said ""hi""\nnext line"\r\nT2,Plain,\r\n');
    expect(rows).toEqual([
      { id: "T1", task: "A, B", note: 'He said "hi"\nnext line' },
      { id: "T2", task: "Plain", note: "" },
    ]);
  });
});
