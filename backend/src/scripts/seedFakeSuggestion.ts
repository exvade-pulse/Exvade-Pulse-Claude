import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, client } from "../db/client.js";
import { objectives, initiatives, projects, sources, suggestions, organizations } from "../db/schema.js";
import { interpretFakeEmail } from "../interpretation/fakeInterpret.js";
import { config } from "../config.js";

// Dev/demo helper: ensures a minimal Objective -> Initiative -> Project chain
// exists, then runs the fake interpretation function against a hardcoded email
// to produce one real `suggestions` row, for exercising the review UI end-to-end.
async function main() {
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

  const fakeEmail = {
    subject: "Bench rig #3 showing intermittent sensor dropout",
    from: "lab-tech@exvadebio.com",
    body: "Saw sensor dropout on rig #3 during today's run, happened twice over 2 hours. Logged timestamps, need someone to check the wiring harness before the next run.",
    receivedAt: new Date(),
  };

  const [source] = await db
    .insert(sources)
    .values({
      organizationId: org.id,
      type: "gmail",
      externalId: `seed-${Date.now()}`,
      receivedAt: fakeEmail.receivedAt,
      rawBody: fakeEmail.body,
    })
    .returning();

  const draft = interpretFakeEmail(fakeEmail, { projectId: project.id });

  const [suggestion] = await db
    .insert(suggestions)
    .values({
      organizationId: org.id,
      sourceId: source.id,
      targetType: draft.targetType,
      targetId: draft.targetId,
      changeType: draft.changeType,
      proposedDiff: draft.proposedDiff,
      reasoning: draft.reasoning,
      confidence: draft.confidence,
    })
    .returning();

  console.log("Seeded fake suggestion:", suggestion.id);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
