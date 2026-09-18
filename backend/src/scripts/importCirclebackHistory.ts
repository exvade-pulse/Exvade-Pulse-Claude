import "dotenv/config";
import { fileURLToPath } from "node:url";
import { parseCirclebackMeta } from "../integrations/circlebackPayload.js";
import { withRateLimitRetry } from "./importHistoricalMinutes.js";

// One-time batch import of historical Circleback meetings via their real
// REST API (GET /api/meetings, bearer-token auth) -- distinct from the live
// webhook integration, which only ever receives *new* meetings going
// forward. Structurally mirrors importHistoricalMinutes.ts (oldest-first,
// --dry-run is fully offline, rate-limit retry wrapping) but pulls from an
// API instead of local files.
//
// Circleback's list endpoint (verified against a real account) already
// returns each meeting's full notes/actionItems -- no separate per-meeting
// detail fetch is needed -- in exactly the same JSON shape the live webhook
// delivers, so this reuses circlebackPayload.ts's parseCirclebackMeta
// directly rather than a second parser.
//
// Usage:
//   CIRCLEBACK_API_KEY=cb_... npm run import:circleback -w backend -- [--dry-run]

const DELAY_BETWEEN_MEETINGS_MS = 1500;
const CIRCLEBACK_API_BASE = "https://circleback.ai/api";

interface CirclebackMeetingListItem {
  id: string;
  name: string;
  createdAt: string;
  notes: string | null;
  actionItems: unknown[];
  [key: string]: unknown;
}

async function fetchAllMeetings(apiKey: string): Promise<CirclebackMeetingListItem[]> {
  const all: CirclebackMeetingListItem[] = [];
  let cursor: string | undefined;

  do {
    const url = cursor ? `${CIRCLEBACK_API_BASE}/meetings?cursor=${cursor}` : `${CIRCLEBACK_API_BASE}/meetings`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) {
      throw new Error(`Circleback API request failed (${response.status}): ${await response.text()}`);
    }
    const page = (await response.json()) as CirclebackMeetingListItem[];
    all.push(...page);

    const link = response.headers.get("link");
    const match = link?.match(/cursor=([^&>]+)/);
    cursor = match ? match[1] : undefined;
  } while (cursor);

  return all;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

async function planImport(apiKey: string): Promise<CirclebackMeetingListItem[]> {
  console.log("Fetching meeting list from Circleback...");
  const meetings = await fetchAllMeetings(apiKey);
  console.log(`Found ${meetings.length} meeting(s) total.\n`);
  // Oldest first, same reasoning as importHistoricalMinutes.ts: the reviewer
  // approves in the order this script runs in, and an out-of-order approval
  // can overwrite a task's latest state with something stale.
  return [...meetings].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

async function runDryRun(apiKey: string): Promise<void> {
  const planned = await planImport(apiKey);

  console.log("Planned processing order (oldest first):");
  planned.forEach((m, i) => {
    const hasContent = m.notes || (Array.isArray(m.actionItems) && m.actionItems.length > 0);
    console.log(`  ${i + 1}. ${formatDate(m.createdAt)}  ${m.name}${hasContent ? "" : "  (no notes/action items yet -- likely noise)"}`);
  });

  console.log(`\nDry run complete: ${planned.length} meeting(s) would be processed. No Claude API calls or database writes were made.`);
}

async function runRealImport(apiKey: string): Promise<void> {
  const planned = await planImport(apiKey);

  console.log("Planned processing order (oldest first):");
  planned.forEach((m, i) => {
    console.log(`  ${i + 1}. ${formatDate(m.createdAt)}  ${m.name}`);
  });

  if (planned.length === 0) {
    console.log("\nNothing to import.");
    return;
  }

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
    throw new Error(`No organization found for domain "${config.allowedDomain}". Sign in once before running this import.`);
  }

  const claudeClient = withRateLimitRetry(getClaudeClient());
  const counts = { created: 0, noise: 0, interpretationFailed: 0, alreadyImported: 0, error: 0 };

  console.log(`\nImporting ${planned.length} meeting(s) into org ${org.id}...\n`);

  for (let i = 0; i < planned.length; i++) {
    const meeting = planned[i];
    const label = `[${i + 1}/${planned.length}] ${meeting.name}`;
    const meta = parseCirclebackMeta(JSON.stringify(meeting));

    try {
      const result = await runInterpretationPipeline(
        db,
        org.id,
        {
          type: "circleback",
          // The real Circleback meeting id -- already ingested meetings
          // (e.g. the one that arrived live via the webhook before this
          // script ran) collide on this and are skipped as duplicates
          // below, not double-processed.
          externalId: meeting.id,
          subject: meta.title,
          from: "Circleback",
          body: meta.body,
          receivedAt: meta.occurredAt,
        },
        claudeClient,
      );

      if (result.skippedAsNoise) {
        counts.noise++;
        console.log(`${label} -> classified as noise`);
      } else if (result.suggestionIds.length > 0) {
        counts.created += result.suggestionIds.length;
        const plural = result.suggestionIds.length === 1 ? "" : "s";
        console.log(`${label} -> ${result.suggestionIds.length} suggestion${plural} created`);
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
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_MEETINGS_MS));
    }
  }

  console.log("\nSummary:");
  console.log(`  Suggestions created: ${counts.created}`);
  console.log(`  Classified as noise: ${counts.noise}`);
  console.log(`  Interpretation failed (source kept): ${counts.interpretationFailed}`);
  console.log(`  Already imported (skipped): ${counts.alreadyImported}`);
  console.log(`  Errors: ${counts.error}`);

  await client.end();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apiKey = process.env.CIRCLEBACK_API_KEY;
  if (!apiKey) {
    throw new Error("CIRCLEBACK_API_KEY is not set. Get one from Circleback's Settings -> API keys.");
  }

  if (dryRun) {
    await runDryRun(apiKey);
  } else {
    await runRealImport(apiKey);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
