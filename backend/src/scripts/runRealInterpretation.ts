import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, client } from "../db/client.js";
import { initiatives, objectives, organizations, projects } from "../db/schema.js";
import { runInterpretationPipeline, type RawIncomingSource } from "../interpretation/pipeline.js";
import { config } from "../config.js";

// Dev/demo helper: exercises the REAL Claude-driven interpretation pipeline
// (noise filter -> interpretation -> suggestion) against one raw email-shaped
// input, requiring a real ANTHROPIC_API_KEY. Ensures the same minimal
// Objective -> Initiative -> Project chain as seedFakeSuggestion.ts exists so
// the interpretation pass has some existing context to match against.
//
// Usage:
//   npm run interpret:real -w backend
//   npm run interpret:real -w backend -- path/to/email.json
//
// The optional JSON file should have shape:
//   { "subject": "...", "from": "...", "body": "...", "receivedAt": "2026-01-01T00:00:00Z" }
async function loadRawSource(): Promise<Pick<RawIncomingSource, "subject" | "from" | "body" | "receivedAt">> {
  const filePath = process.argv[2];
  if (filePath) {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return {
      subject: parsed.subject,
      from: parsed.from,
      body: parsed.body,
      receivedAt: parsed.receivedAt ? new Date(parsed.receivedAt) : new Date(),
    };
  }

  return {
    subject: "Rig #3 still dropping sensor readings",
    from: "lab-tech@exvadebio.com",
    body: "Following up on the bench rig #3 issue -- it happened again today, three times in one run. I don't think it's the wiring harness, the connector looks fine. Might be a firmware issue on the sensor board. Can someone from firmware take a look before we run again tomorrow?",
    receivedAt: new Date(),
  };
}

async function main() {
  if (!config.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Set it in backend/.env (see backend/.env.example) to run this script.",
    );
  }

  let [org] = await db.select().from(organizations).where(eq(organizations.domain, config.allowedDomain));
  if (!org) {
    [org] = await db
      .insert(organizations)
      .values({ name: "Exvade Bioscience", domain: config.allowedDomain })
      .returning();
  }

  let [objective] = await db.select().from(objectives).where(eq(objectives.organizationId, org.id));
  if (!objective) {
    [objective] = await db
      .insert(objectives)
      .values({
        organizationId: org.id,
        title: "Advance Tumor Monorail Device toward pivotal trial",
        description: "Seed objective for local development.",
        priority: "high",
      })
      .returning();
  }

  let [initiative] = await db.select().from(initiatives).where(eq(initiatives.objectiveId, objective.id));
  if (!initiative) {
    [initiative] = await db
      .insert(initiatives)
      .values({
        organizationId: org.id,
        objectiveId: objective.id,
        title: "Pre-clinical validation",
        priority: "high",
      })
      .returning();
  }

  let [project] = await db.select().from(projects).where(eq(projects.initiativeId, initiative.id));
  if (!project) {
    [project] = await db
      .insert(projects)
      .values({
        organizationId: org.id,
        initiativeId: initiative.id,
        title: "Bench testing protocol",
      })
      .returning();
  }

  const raw = await loadRawSource();

  const result = await runInterpretationPipeline(db, org.id, {
    type: "gmail",
    externalId: `real-${Date.now()}`,
    ...raw,
  });

  if (result.skippedAsNoise) {
    console.log(`Source ${result.sourceId} classified as noise -- no suggestion created.`);
  } else if (result.suggestionId) {
    console.log(`Created suggestion ${result.suggestionId} from source ${result.sourceId}.`);
  } else {
    console.log(`Source ${result.sourceId} kept, but interpretation failed -- see error above. No suggestion created.`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
