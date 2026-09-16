import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
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

describe("GET /api/sources/:id", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns the full source including rawBody for the caller's org", async () => {
    const app = await buildApp();
    const fixture = await createFixtureOrg(db, { domain: "source-detail.test" });

    const response = await app.inject({
      method: "GET",
      url: `/api/sources/${fixture.source.id}`,
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as { source: { id: string; type: string; rawBody: string | null } };
    expect(body.source.id).toBe(fixture.source.id);
    expect(body.source.type).toBe("gmail");
    expect(body.source.rawBody).toBe("fixture email body");
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: `/api/sources/${randomUUID()}` });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("404s for a malformed id", async () => {
    const app = await buildApp();
    const fixture = await createFixtureOrg(db, { domain: "source-malformed.test" });
    const response = await app.inject({
      method: "GET",
      url: "/api/sources/not-a-uuid",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();
    expect(response.statusCode).toBe(404);
  });

  it("404s for a nonexistent id", async () => {
    const app = await buildApp();
    const fixture = await createFixtureOrg(db, { domain: "source-missing.test" });
    const response = await app.inject({
      method: "GET",
      url: `/api/sources/${randomUUID()}`,
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(fixture) },
    });
    await app.close();
    expect(response.statusCode).toBe(404);
  });

  it("404s (not a leak) for a source belonging to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "source-org-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "source-org-b.test" });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/sources/${orgB.source.id}`,
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    await app.close();
    expect(response.statusCode).toBe(404);
  });
});
