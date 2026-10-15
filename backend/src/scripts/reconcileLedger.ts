// Compares a Pulse export (Settings → Export, the full JSON) with an outside
// task ledger CSV (columns: id, task, and optionally disposition, ...).
// Reads two local files and writes two reports next to the ledger; touches
// no database.
//
//   npx tsx src/scripts/reconcileLedger.ts <pulse-export.json> <task-ledger.csv>
//
// Writes <ledger>-reconciliation.csv (one row per ledger task: exact,
// exact_with_possible_duplicates, ambiguous or absent, with candidates) and
// <ledger>-unseen.csv (live Pulse tasks the ledger never mentions).
import { readFileSync, writeFileSync } from "node:fs";
import { parseCsv, reconcileLedger, reportCsv, unseenCsv, type ExportTask, type LedgerRow } from "../reconcile/ledger.js";

const [exportPath, ledgerPath] = process.argv.slice(2);
if (!exportPath || !ledgerPath) {
  console.error("Usage: npx tsx src/scripts/reconcileLedger.ts <pulse-export.json> <task-ledger.csv>");
  process.exit(1);
}

const exported = JSON.parse(readFileSync(exportPath, "utf8")) as { exportedAt: string; tasks: ExportTask[] };
const ledger = parseCsv(readFileSync(ledgerPath, "utf8")) as LedgerRow[];
if (!ledger.length || !("task" in ledger[0])) {
  console.error("The ledger needs a header row with at least 'id' and 'task' columns.");
  process.exit(1);
}

const result = reconcileLedger(ledger, exported.tasks);
const base = ledgerPath.replace(/\.csv$/i, "");
writeFileSync(`${base}-reconciliation.csv`, "﻿" + reportCsv(result));
writeFileSync(`${base}-unseen.csv`, "﻿" + unseenCsv(result));
console.log(`Export from ${exported.exportedAt}: ${exported.tasks.length} tasks. Ledger: ${ledger.length} rows.`);
console.log(result.counts);
console.log(`Wrote ${base}-reconciliation.csv and ${base}-unseen.csv`);
