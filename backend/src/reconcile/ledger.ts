import { titleSimilarity, titleTokens } from "../suggestions/similarity.js";

// Matches an outside task ledger (e.g. a reviewer's list of task names read
// off screen) against a Pulse export. Only an exact title match (after
// normalizing case, spacing, dashes and quotes) counts as a match, and only
// when it's unique; anything else is reported for a person to resolve.
// Similar-looking titles are listed as candidates, never matched.

export type MatchStatus = "exact" | "exact_with_possible_duplicates" | "ambiguous" | "absent";

export interface LedgerRow {
  id: string;
  task: string;
  [key: string]: string;
}

export interface ExportTask {
  id: string;
  title: string;
  status: string;
  outcome: string | null;
  project: string | null;
  supersededById: string | null;
}

export interface LedgerMatch {
  ledger: LedgerRow;
  status: MatchStatus;
  match: ExportTask | null;
  // Exact-title matches when there is more than one, or similar titles when
  // there is none: for a person to choose from.
  candidates: ExportTask[];
  // Other records whose titles closely resemble the match: possible duplicates.
  possibleDuplicates: ExportTask[];
}

export interface Reconciliation {
  matches: LedgerMatch[];
  // Live (not merged) export records no ledger row matched.
  unseen: ExportTask[];
  counts: Record<MatchStatus | "unseen", number>;
}

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Deliberately loose: these only list names for a person to compare.
const CANDIDATE_THRESHOLD = 0.55;

export function reconcileLedger(ledger: LedgerRow[], tasks: ExportTask[]): Reconciliation {
  const byTitle = new Map<string, ExportTask[]>();
  for (const t of tasks) byTitle.set(normalizeTitle(t.title), [...(byTitle.get(normalizeTitle(t.title)) ?? []), t]);
  const tokens = new Map(tasks.map((t) => [t.id, titleTokens(t.title)]));
  const similar = (title: string, threshold: number, exclude: Set<string>) => {
    const own = titleTokens(title);
    return tasks
      .filter((t) => !exclude.has(t.id))
      .map((t) => ({ t, score: titleSimilarity(own, tokens.get(t.id)!) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.t);
  };

  const matched = new Set<string>();
  const matches: LedgerMatch[] = ledger.map((row) => {
    const exact = byTitle.get(normalizeTitle(row.task)) ?? [];
    // A merged-away copy doesn't make an exact title ambiguous if exactly
    // one live record carries it.
    const live = exact.filter((t) => !t.supersededById);
    const pick = live.length === 1 ? live[0] : exact.length === 1 ? exact[0] : null;
    if (pick) {
      matched.add(pick.id);
      const dupes = similar(pick.title, CANDIDATE_THRESHOLD, new Set([pick.id])).filter((t) => !t.supersededById);
      return { ledger: row, status: dupes.length ? "exact_with_possible_duplicates" : "exact", match: pick, candidates: [], possibleDuplicates: dupes };
    }
    if (exact.length > 1) return { ledger: row, status: "ambiguous", match: null, candidates: exact, possibleDuplicates: [] };
    const near = similar(row.task, CANDIDATE_THRESHOLD, new Set());
    return { ledger: row, status: near.length ? "ambiguous" : "absent", match: null, candidates: near, possibleDuplicates: [] };
  });

  const unseen = tasks.filter((t) => !t.supersededById && !matched.has(t.id));
  const counts = { exact: 0, exact_with_possible_duplicates: 0, ambiguous: 0, absent: 0, unseen: unseen.length };
  for (const m of matches) counts[m.status]++;
  return { matches, unseen, counts };
}

// RFC 4180-style CSV: quoted fields may contain commas, quotes ("") and
// line breaks. Returns rows keyed by the header line.
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

function cell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const describe = (t: ExportTask) => `${t.title} [${t.status}${t.supersededById ? ", merged" : ""}] (${t.outcome ?? "no outcome"} / ${t.project ?? "no project"}) id=${t.id}`;

export function reportCsv(r: Reconciliation): string {
  const head = ["ledger_id", "ledger_task", "ledger_disposition", "match_status", "pulse_id", "pulse_title", "pulse_status", "pulse_outcome", "pulse_project", "candidates", "possible_duplicates"];
  const lines = r.matches.map((m) =>
    [
      m.ledger.id,
      m.ledger.task,
      m.ledger.disposition ?? "",
      m.status,
      m.match?.id ?? "",
      m.match?.title ?? "",
      m.match?.status ?? "",
      m.match?.outcome ?? "",
      m.match?.project ?? "",
      m.candidates.map(describe).join(" | "),
      m.possibleDuplicates.map(describe).join(" | "),
    ]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\r\n");
}

export function unseenCsv(r: Reconciliation): string {
  const head = ["pulse_id", "pulse_title", "pulse_status", "pulse_outcome", "pulse_project"];
  return [head.join(","), ...r.unseen.map((t) => [t.id, t.title, t.status, t.outcome ?? "", t.project ?? ""].map(cell).join(","))].join("\r\n");
}
