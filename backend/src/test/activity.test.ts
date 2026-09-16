import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { auditLog } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";

const { db, client } = testDb();

afterAll(async () => {
  await client.end();
});

async function tokenFor(fixture: Awaited<ReturnType<typeof createFixtureOrg>>) {
  return signSession({
    userId: fixture.user.id,
    organizationId: fixture.org.id,
    email: fixture.user.email,
    role: fixture.authorization.role,
  });
}

describe("GET /api/activity", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/activity" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("returns only the caller's organization's entries, newest first", async () => {
    const orgA = await createFixtureOrg(db, { domain: "activity-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "activity-org-b.test" });

    const older = new Date(Date.now() - 60_000);
    const newer = new Date();

    const [olderEntry] = await db
      .insert(auditLog)
      .values({
        organizationId: orgA.org.id,
        actorId: orgA.user.id,
        action: "decision.created",
        entityType: "decision",
        entityId: randomUUID(),
        details: { title: "Older" },
        createdAt: older,
      })
      .returning();

    const [newerEntry] = await db
      .insert(auditLog)
      .values({
        organizationId: orgA.org.id,
        actorId: orgA.user.id,
        action: "decision.resolved",
        entityType: "decision",
        entityId: randomUUID(),
        details: { resolution: "Newer" },
        createdAt: newer,
      })
      .returning();

    await db.insert(auditLog).values({
      organizationId: orgB.org.id,
      actorId: orgB.user.id,
      action: "decision.created",
      entityType: "decision",
      entityId: randomUUID(),
      details: { title: "Belongs to org B" },
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: Array<{ id: string; action: string }> };
    const ids = body.entries.map((e) => e.id);
    expect(ids).toContain(olderEntry.id);
    expect(ids).toContain(newerEntry.id);
    expect(ids).toHaveLength(2);
    expect(body.entries[0].id).toBe(newerEntry.id);
    expect(body.entries[1].id).toBe(olderEntry.id);
  });

  it("joins the actor's name and email when actorId is set, and handles a null actorId gracefully", async () => {
    const fixture = await createFixtureOrg(db, { domain: "activity-actor.test" });

    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      action: "suggestion.approved",
      entityType: "task",
      entityId: randomUUID(),
      details: {},
    });

    await db.insert(auditLog).values({
      organizationId: fixture.org.id,
      actorId: null,
      action: "user.authorized",
      entityType: "authorized_user",
      entityId: null,
      details: { email: "someone@activity-actor.test" },
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      entries: Array<{ action: string; actorName: string | null; actorEmail: string | null; entityId: string | null }>;
    };
    expect(body.entries).toHaveLength(2);

    const withActor = body.entries.find((e) => e.action === "suggestion.approved");
    expect(withActor?.actorName).toBe(fixture.user.name);
    expect(withActor?.actorEmail).toBe(fixture.user.email);

    const withoutActor = body.entries.find((e) => e.action === "user.authorized");
    expect(withoutActor?.actorName).toBeNull();
    expect(withoutActor?.actorEmail).toBeNull();
    expect(withoutActor?.entityId).toBeNull();
  });
});
