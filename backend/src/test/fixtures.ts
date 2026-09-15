import { randomUUID } from "node:crypto";
import type { Database } from "../db/client.js";
import { initiatives, objectives, organizations, projects, sources, users } from "../db/schema.js";

export async function createFixtureOrg(db: Database, opts: { domain: string }) {
  const [org] = await db.insert(organizations).values({ name: opts.domain, domain: opts.domain }).returning();

  const [user] = await db
    .insert(users)
    .values({
      organizationId: org.id,
      googleId: `google-${opts.domain}`,
      email: `reviewer@${opts.domain}`,
      name: "Test Reviewer",
    })
    .returning();

  const [objective] = await db
    .insert(objectives)
    .values({ organizationId: org.id, title: "Test objective" })
    .returning();

  const [initiative] = await db
    .insert(initiatives)
    .values({ organizationId: org.id, objectiveId: objective.id, title: "Test initiative" })
    .returning();

  const [project] = await db
    .insert(projects)
    .values({ organizationId: org.id, initiativeId: initiative.id, title: "Test project" })
    .returning();

  const [source] = await db
    .insert(sources)
    .values({
      organizationId: org.id,
      type: "gmail",
      externalId: `ext-${randomUUID()}`,
      receivedAt: new Date(),
      rawBody: "fixture email body",
    })
    .returning();

  return { org, user, objective, initiative, project, source };
}
