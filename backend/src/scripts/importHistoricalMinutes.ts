import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "@anthropic-ai/sdk";
import { parse as chronoParse } from "chrono-node";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { ClaudeClient } from "../interpretation/claudeClient.js";

// One-time batch import of ~200 real historical meeting-minutes documents
// (Word/PDF) into the same ingestion pipeline every other source goes
// through. See README.md for usage. Two hard requirements drive most of the
// design here:
//   1. Documents must be fed to the pipeline oldest-first, because the human
//      reviewer approves suggestions in the same order this script runs in,
//      and approving a newer update after an older one is a lossy no-op --
//      but approving them out of order can overwrite a task's latest_update
//      with stale content.
//   2. --dry-run must be fully offline (no Claude calls, no DB writes) so a
//      bad date-parse can be caught before it silently corrupts that order.
//
// Usage:
//   npm run import:minutes -w backend -- [folderPath] [--dry-run]

const DEFAULT_IMPORT_FOLDER = String.raw`C:\Users\meeha\Documents\ExvadePulse-Import`;
const SUPPORTED_EXTENSIONS = new Set([".docx", ".pdf"]);
// Below this, extracted text is treated as an extraction failure (corrupt
// file, or a scanned-image PDF with no text layer) rather than a real,
// if short, set of meeting minutes.
const MIN_TEXT_LENGTH = 40;
const DELAY_BETWEEN_DOCS_MS = 1500;
const MAX_RETRY_ATTEMPTS = 6;
const RETRY_BASE_BACKOFF_MS = 2000;

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  filename: string;
}

// Recursively walks `rootDir` for .docx/.pdf files. Skips Word's own "~$"
// lock files (left behind when a document is open) and dotfiles, neither of
// which are real content.
export function discoverFiles(rootDir: string): DiscoveredFile[] {
  const results: DiscoveredFile[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith("~$") || entry.name.startsWith(".")) continue;
      if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      results.push({
        absolutePath: fullPath,
        relativePath: path.relative(rootDir, fullPath),
        filename: entry.name,
      });
    }
  }

  walk(rootDir);
  return results;
}

// Matches a bare YYYYMMDD run (e.g. "20250314"), which chrono-node's default
// parser does not pick up on its own -- common enough in real filenames to be
// worth a dedicated check rather than relying on chrono alone.
const COMPACT_DATE_RE = /(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/;

function tryCompactDate(text: string): Date | null {
  const match = text.match(COMPACT_DATE_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date silently rolls over invalid combinations (e.g. Feb 30 -> Mar 2) --
  // a round-trip check catches that instead of trusting a bogus date.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

// Filenames/content use several different separator conventions for the same
// date; trying a few cheap normalizations gets chrono-node's parser to catch
// most of them without hand-rolling a large regex bank per format.
const NORMALIZATION_VARIANTS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/[_.]/g, "-"),
  (s) => s.replace(/[_.-]/g, " "),
];

function tryChronoConfidentDate(text: string): Date | null {
  for (const normalize of NORMALIZATION_VARIANTS) {
    const results = chronoParse(normalize(text));
    for (const result of results) {
      // Only trust a match where day, month, AND year were all actually
      // present in the text (not implied/guessed by chrono from "now") --
      // an implied year on a 200-document historical import is exactly the
      // kind of silent corruption this script exists to avoid.
      if (result.start.isCertain("year") && result.start.isCertain("month") && result.start.isCertain("day")) {
        return result.start.date();
      }
    }
  }
  return null;
}

export function parseDateFromFilename(filename: string): Date | null {
  const stem = filename.replace(/\.(docx|pdf)$/i, "");
  return tryCompactDate(stem) ?? tryChronoConfidentDate(stem);
}

export function parseDateFromContent(content: string): Date | null {
  const excerpt = content.slice(0, 1000);
  return tryCompactDate(excerpt) ?? tryChronoConfidentDate(excerpt);
}

export type DateSource = "filename" | "content";

export interface ResolvedDate {
  date: Date;
  source: DateSource;
}

export function resolveDocumentDate(filename: string, content: string): ResolvedDate | null {
  const fromFilename = parseDateFromFilename(filename);
  if (fromFilename) return { date: fromFilename, source: "filename" };
  const fromContent = parseDateFromContent(content);
  if (fromContent) return { date: fromContent, source: "content" };
  return null;
}

// Stable across reruns of the same file path -- this is the resumability
// mechanism: sources.externalId is unique per org, so re-running this script
// after a crash/interruption re-derives the same id for an already-ingested
// file and the insert conflicts instead of duplicating.
export function deriveExternalId(absolutePath: string): string {
  const normalized = path.resolve(absolutePath).toLowerCase().split(path.sep).join("/");
  return `document:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.(docx|pdf)$/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DatedItem {
  resolvedDate: Date;
}

// Oldest first: the entire point of running this script instead of ingesting
// ad hoc is so the reviewer approves suggestions in chronological order.
export function sortByDateAscending<T extends DatedItem>(items: T[]): T[] {
  return [...items].sort((a, b) => a.resolvedDate.getTime() - b.resolvedDate.getTime());
}

async function extractText(absolutePath: string): Promise<string> {
  const ext = path.extname(absolutePath).toLowerCase();
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: absolutePath });
    return result.value;
  }
  if (ext === ".pdf") {
    const buffer = await readFile(absolutePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  throw new Error(`Unsupported file extension: ${ext}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableApiError(err: unknown): err is APIError {
  if (!(err instanceof APIError)) return false;
  return err.status === 429 || err.status === 529 || (err.status !== undefined && err.status >= 500);
}

// Wraps the real Claude client so a 429/rate-limit (or transient 5xx) is
// retried with backoff instead of surfacing to pipeline.ts, which would
// otherwise treat it exactly like a genuine, permanent redaction/
// interpretation failure (see pipeline.ts's fail-closed/fail-open handling).
// Non-retryable errors pass straight through so that handling is unchanged.
export function withRateLimitRetry(baseClient: ClaudeClient): ClaudeClient {
  return {
    async createMessage(params) {
      let attempt = 0;
      for (;;) {
        try {
          return await baseClient.createMessage(params);
        } catch (err) {
          attempt += 1;
          if (!isRetryableApiError(err) || attempt > MAX_RETRY_ATTEMPTS) {
            throw err;
          }
          const backoffMs = RETRY_BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 1000);
          console.warn(
            `  Claude API returned ${err.status} (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}); backing off ${backoffMs}ms before retrying...`,
          );
          await sleep(backoffMs);
        }
      }
    },
  };
}

interface PlannedItem extends DiscoveredFile, DatedItem {
  dateSource: DateSource;
  text: string;
}

interface SkippedItem {
  relativePath: string;
  reason: string;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function printSkippedLists(extractionSkipped: SkippedItem[], dateSkipped: SkippedItem[]) {
  if (extractionSkipped.length > 0) {
    console.log(`\nSkipped -- extraction failed or produced empty/near-empty text (${extractionSkipped.length}):`);
    for (const item of extractionSkipped) console.log(`  - ${item.relativePath}: ${item.reason}`);
  }
  if (dateSkipped.length > 0) {
    console.log(
      `\nCouldn't determine a date, skipped -- rename or clarify these and re-run (${dateSkipped.length}):`,
    );
    for (const item of dateSkipped) console.log(`  - ${item.relativePath}`);
  }
}

async function planImport(folderPath: string): Promise<{
  planned: PlannedItem[];
  extractionSkipped: SkippedItem[];
  dateSkipped: SkippedItem[];
}> {
  console.log(`Scanning ${folderPath} for .docx/.pdf files...`);
  const files = discoverFiles(folderPath);
  console.log(`Found ${files.length} candidate file(s).\n`);

  const planned: PlannedItem[] = [];
  const extractionSkipped: SkippedItem[] = [];
  const dateSkipped: SkippedItem[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await extractText(file.absolutePath);
    } catch (err) {
      extractionSkipped.push({
        relativePath: file.relativePath,
        reason: `extraction error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (text.trim().length < MIN_TEXT_LENGTH) {
      extractionSkipped.push({
        relativePath: file.relativePath,
        reason: "extracted text is empty or near-empty (possibly a scanned/image-only document)",
      });
      continue;
    }

    const resolved = resolveDocumentDate(file.filename, text);
    if (!resolved) {
      dateSkipped.push({
        relativePath: file.relativePath,
        reason: "no confident date found in filename or the first ~1000 characters of content",
      });
      continue;
    }

    planned.push({ ...file, text, resolvedDate: resolved.date, dateSource: resolved.source });
  }

  return { planned: sortByDateAscending(planned), extractionSkipped, dateSkipped };
}

async function runDryRun(folderPath: string): Promise<void> {
  const { planned, extractionSkipped, dateSkipped } = await planImport(folderPath);

  console.log("Planned processing order (oldest first):");
  planned.forEach((item, i) => {
    console.log(`  ${i + 1}. ${formatDate(item.resolvedDate)} (from ${item.dateSource})  ${item.relativePath}`);
  });

  printSkippedLists(extractionSkipped, dateSkipped);

  console.log(
    `\nDry run complete: ${planned.length} file(s) would be processed, ${extractionSkipped.length} skipped for extraction, ${dateSkipped.length} skipped for date. No Claude API calls or database writes were made.`,
  );
}

async function runRealImport(folderPath: string): Promise<void> {
  const { planned, extractionSkipped, dateSkipped } = await planImport(folderPath);

  console.log("Planned processing order (oldest first):");
  planned.forEach((item, i) => {
    console.log(`  ${i + 1}. ${formatDate(item.resolvedDate)} (from ${item.dateSource})  ${item.relativePath}`);
  });
  printSkippedLists(extractionSkipped, dateSkipped);

  if (planned.length === 0) {
    console.log("\nNothing to import.");
    return;
  }

  // Imported lazily so --dry-run never opens a DB connection or requires
  // DATABASE_URL/ANTHROPIC_API_KEY to be set at all.
  const [{ db, client }, { organizations }, { runInterpretationPipeline }, { getClaudeClient }, { isUniqueViolation }, { config }, { eq }] =
    await Promise.all([
      import("../db/client.js"),
      import("../db/schema.js"),
      import("../interpretation/pipeline.js"),
      import("../interpretation/claudeClient.js"),
      import("../integrations/webhookIngest.js"),
      import("../config.js"),
      import("drizzle-orm"),
    ]);

  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Set it in backend/.env to run a real (non-dry-run) import.");
  }

  const [org] = await db.select().from(organizations).where(eq(organizations.domain, config.allowedDomain));
  if (!org) {
    throw new Error(
      `No organization found for domain "${config.allowedDomain}". Sign in once (or run "npm run interpret:real -w backend") to bootstrap the organization before running this import.`,
    );
  }

  const claudeClient = withRateLimitRetry(getClaudeClient());

  const counts = { created: 0, noise: 0, interpretationFailed: 0, alreadyImported: 0, error: 0 };

  console.log(`\nImporting ${planned.length} document(s) into org ${org.id}...\n`);

  for (let i = 0; i < planned.length; i++) {
    const item = planned[i];
    const label = `[${i + 1}/${planned.length}] ${item.relativePath}`;

    try {
      const result = await runInterpretationPipeline(
        db,
        org.id,
        {
          type: "document",
          externalId: deriveExternalId(item.absolutePath),
          subject: titleFromFilename(item.filename),
          from: "Historical meeting minutes import",
          body: item.text,
          receivedAt: item.resolvedDate,
        },
        claudeClient,
      );

      if (result.skippedAsNoise) {
        counts.noise++;
        console.log(`${label} -> classified as noise`);
      } else if (result.suggestionIds.length > 0) {
        counts.created += result.suggestionIds.length;
        const plural = result.suggestionIds.length === 1 ? "" : "s";
        console.log(`${label} -> ${result.suggestionIds.length} suggestion${plural} created (${result.suggestionIds.join(", ")})`);
      } else {
        counts.interpretationFailed++;
        console.log(`${label} -> interpretation failed, no suggestion (source kept for review)`);
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        counts.alreadyImported++;
        console.log(`${label} -> already imported, skipping`);
      } else {
        counts.error++;
        console.error(`${label} -> ERROR:`, err instanceof Error ? err.message : err);
      }
    }

    if (i < planned.length - 1) {
      await sleep(DELAY_BETWEEN_DOCS_MS);
    }
  }

  console.log("\nSummary:");
  console.log(`  Suggestions created: ${counts.created}`);
  console.log(`  Classified as noise: ${counts.noise}`);
  console.log(`  Interpretation failed (source kept): ${counts.interpretationFailed}`);
  console.log(`  Already imported (skipped): ${counts.alreadyImported}`);
  console.log(`  Errors: ${counts.error}`);
  printSkippedLists(extractionSkipped, dateSkipped);

  await client.end();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const folderPath = args.find((a) => !a.startsWith("--")) ?? DEFAULT_IMPORT_FOLDER;

  if (dryRun) {
    await runDryRun(folderPath);
  } else {
    await runRealImport(folderPath);
  }
}

// Guard against running main() as a side effect of import -- the test file
// imports this module's pure-logic exports directly, and without this check
// every test run would silently trigger a real (non-dry-run) import against
// DEFAULT_IMPORT_FOLDER, burning real Claude API credits and writing to
// whichever database TEST_DATABASE_URL/DATABASE_URL currently resolves to.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
