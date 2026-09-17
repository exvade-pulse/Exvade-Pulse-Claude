import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { createCompanyEntity, listCompanyEntities } from "../entities/manage.js";

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

describe("company entities module", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("creates an entity with kind/notes, org-scoped", async () => {
    const fixture = await createFixtureOrg(db, { domain: "entity-create.test" });

    const entity = await createCompanyEntity(db, {
      organizationId: fixture.org.id,
      name: "Duke University",
      kind: "clinical trial site",
      notes: "Site for the pivotal trial.",
    });

    expect(entity.name).toBe("Duke University");
    expect(entity.kind).toBe("clinical trial site");
    expect(entity.organizationId).toBe(fixture.org.id);
  });

  it("lists entities alphabetically by name, org-isolated", async () => {
    const orgA = await createFixtureOrg(db, { domain: "entity-list-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "entity-list-b.test" });

    await createCompanyEntity(db, { organizationId: orgA.org.id, name: "NIH" });
    await createCompanyEntity(db, { organizationId: orgA.org.id, name: "Duke University" });
    await createCompanyEntity(db, { organizationId: orgB.org.id, name: "Other org's entity" });

    const list = await listCompanyEntities(db, orgA.org.id);
    expect(list.map((e) => e.name)).toEqual(["Duke University", "NIH"]);
  });
});

describe("GET/POST /api/company-entities", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/company-entities" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("400s when name is missing or blank", async () => {
    const fixture = await createFixtureOrg(db, { domain: "entity-api-blank.test" });
    const app = await buildApp();
    const cookies = { [SESSION_COOKIE_NAME]: await tokenFor(fixture) };

    const missing = await app.inject({ method: "POST", url: "/api/company-entities", payload: {}, cookies });
    expect(missing.statusCode).toBe(400);

    const blank = await app.inject({ method: "POST", url: "/api/company-entities", payload: { name: "  " }, cookies });
    expect(blank.statusCode).toBe(400);

    await app.close();
  });

  it("creates and lists an entity via the API, org-isolated", async () => {
    const orgA = await createFixtureOrg(db, { domain: "entity-api-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "entity-api-b.test" });

    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/company-entities",
      payload: { name: "FDA", kind: "regulator" },
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    expect(created.statusCode).toBe(201);

    const listA = await app.inject({
      method: "GET",
      url: "/api/company-entities",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgA) },
    });
    const bodyA = listA.json() as { entities: Array<{ name: string }> };
    expect(bodyA.entities.map((e) => e.name)).toEqual(["FDA"]);

    const listB = await app.inject({
      method: "GET",
      url: "/api/company-entities",
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgB) },
    });
    const bodyB = listB.json() as { entities: unknown[] };
    expect(bodyB.entities).toEqual([]);

    await app.close();
  });
});
