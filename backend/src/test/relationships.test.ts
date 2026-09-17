import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import { createFixtureOrg } from "./fixtures.js";
import { initiatives, tasks } from "../db/schema.js";
import { buildApp } from "../app.js";
import { signSession, SESSION_COOKIE_NAME } from "../auth/jwt.js";
import { createCompanyEntity } from "../entities/manage.js";
import {
  createRelationship,
  deleteRelationship,
  listRelationshipsForEntity,
  RelationshipError,
} from "../relationships/manage.js";

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

describe("relationships module", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("creates a relationship between two real entities of different types", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rel-create.test" });
    const entity = await createCompanyEntity(db, { organizationId: fixture.org.id, name: "FDA", kind: "regulator" });

    const relationship = await createRelationship(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      fromType: "project",
      fromId: fixture.project.id,
      toType: "company_entity",
      toId: entity.id,
      relationType: "awaiting_response_from",
      note: "Waiting on pre-sub feedback.",
    });

    expect(relationship.relationType).toBe("awaiting_response_from");
    expect(relationship.createdBy).toBe(fixture.user.id);
  });

  it("rejects a relationship whose fromId doesn't belong to this organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "rel-cross-org-from.test" });
    const orgB = await createFixtureOrg(db, { domain: "rel-cross-org-from-b.test" });

    await expect(
      createRelationship(db, {
        organizationId: orgA.org.id,
        actorId: orgA.user.id,
        fromType: "project",
        fromId: orgB.project.id,
        toType: "project",
        toId: orgA.project.id,
        relationType: "blocks",
      }),
    ).rejects.toBeInstanceOf(RelationshipError);
  });

  it("rejects a relationship pointing at a nonexistent id", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rel-missing.test" });

    await expect(
      createRelationship(db, {
        organizationId: fixture.org.id,
        actorId: fixture.user.id,
        fromType: "project",
        fromId: fixture.project.id,
        toType: "decision",
        toId: randomUUID(),
        relationType: "informs",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a self-referential relationship", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rel-self.test" });

    await expect(
      createRelationship(db, {
        organizationId: fixture.org.id,
        actorId: fixture.user.id,
        fromType: "project",
        fromId: fixture.project.id,
        toType: "project",
        toId: fixture.project.id,
        relationType: "depends_on",
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("listRelationshipsForEntity resolves both directions and both hierarchy and company-entity names", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rel-list.test" });
    const [otherInitiative] = await db
      .insert(initiatives)
      .values({ organizationId: fixture.org.id, objectiveId: fixture.objective.id, title: "Other initiative" })
      .returning();
    const entity = await createCompanyEntity(db, { organizationId: fixture.org.id, name: "NIH", kind: "funder" });

    // Outgoing: this project depends_on the other initiative.
    await createRelationship(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      fromType: "project",
      fromId: fixture.project.id,
      toType: "initiative",
      toId: otherInitiative.id,
      relationType: "depends_on",
    });
    // Incoming: the company entity is funded_by... well, reversed -- this
    // project is funded_by the entity, so from this project's perspective
    // it's outgoing too. Use the entity as the `from` side instead so this
    // project sees a genuine incoming edge.
    await createRelationship(db, {
      organizationId: fixture.org.id,
      actorId: fixture.user.id,
      fromType: "company_entity",
      fromId: entity.id,
      toType: "project",
      toId: fixture.project.id,
      relationType: "funded_by",
    });

    const relationships = await listRelationshipsForEntity(db, fixture.org.id, "project", fixture.project.id);
    expect(relationships).toHaveLength(2);

    const outgoing = relationships.find((r) => r.direction === "outgoing")!;
    expect(outgoing.otherType).toBe("initiative");
    expect(outgoing.otherName).toBe("Other initiative");
    expect(outgoing.relationType).toBe("depends_on");

    const incoming = relationships.find((r) => r.direction === "incoming")!;
    expect(incoming.otherType).toBe("company_entity");
    expect(incoming.otherName).toBe("NIH");
    expect(incoming.relationType).toBe("funded_by");
  });

  it("deleteRelationship removes it and is org-scoped", async () => {
    const orgA = await createFixtureOrg(db, { domain: "rel-delete-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "rel-delete-b.test" });

    const relationship = await createRelationship(db, {
      organizationId: orgA.org.id,
      actorId: orgA.user.id,
      fromType: "project",
      fromId: orgA.project.id,
      toType: "initiative",
      toId: orgA.initiative.id,
      relationType: "coupled_with",
    });

    const deletedByWrongOrg = await deleteRelationship(db, orgB.org.id, relationship.id);
    expect(deletedByWrongOrg).toBe(false);

    const deleted = await deleteRelationship(db, orgA.org.id, relationship.id);
    expect(deleted).toBe(true);

    const remaining = await listRelationshipsForEntity(db, orgA.org.id, "project", orgA.project.id);
    expect(remaining).toHaveLength(0);
  });
});

describe("GET/POST/DELETE /api/relationships", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("returns 401 for unauthenticated requests on all three methods", async () => {
    const app = await buildApp();
    const get = await app.inject({ method: "GET", url: `/api/relationships?entityType=task&entityId=${randomUUID()}` });
    expect(get.statusCode).toBe(401);
    const post = await app.inject({ method: "POST", url: "/api/relationships", payload: {} });
    expect(post.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: `/api/relationships/${randomUUID()}` });
    expect(del.statusCode).toBe(401);
    await app.close();
  });

  it("400s for an invalid entityType or a malformed entityId on GET", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rel-api-get-bad.test" });
    const app = await buildApp();
    const cookies = { [SESSION_COOKIE_NAME]: await tokenFor(fixture) };

    const badType = await app.inject({
      method: "GET",
      url: `/api/relationships?entityType=not-a-type&entityId=${randomUUID()}`,
      cookies,
    });
    expect(badType.statusCode).toBe(400);

    const badId = await app.inject({
      method: "GET",
      url: "/api/relationships?entityType=task&entityId=not-a-uuid",
      cookies,
    });
    expect(badId.statusCode).toBe(400);

    await app.close();
  });

  it("creates via POST, lists via GET, and deletes via DELETE, end to end", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rel-api-e2e.test" });
    const [taskA] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task A" })
      .returning();
    const [taskB] = await db
      .insert(tasks)
      .values({ organizationId: fixture.org.id, projectId: fixture.project.id, title: "Task B" })
      .returning();

    const app = await buildApp();
    const cookies = { [SESSION_COOKIE_NAME]: await tokenFor(fixture) };

    const created = await app.inject({
      method: "POST",
      url: "/api/relationships",
      payload: { fromType: "task", fromId: taskA.id, toType: "task", toId: taskB.id, relationType: "blocks" },
      cookies,
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { relationship: { id: string } };

    const list = await app.inject({
      method: "GET",
      url: `/api/relationships?entityType=task&entityId=${taskB.id}`,
      cookies,
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { relationships: Array<{ direction: string; otherName: string }> };
    expect(listBody.relationships).toHaveLength(1);
    expect(listBody.relationships[0].direction).toBe("incoming");
    expect(listBody.relationships[0].otherName).toBe("Task A");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/relationships/${createdBody.relationship.id}`,
      cookies,
    });
    expect(deleted.statusCode).toBe(200);

    const listAfterDelete = await app.inject({
      method: "GET",
      url: `/api/relationships?entityType=task&entityId=${taskB.id}`,
      cookies,
    });
    expect((listAfterDelete.json() as { relationships: unknown[] }).relationships).toEqual([]);

    await app.close();
  });

  it("404s deleting a relationship belonging to a different organization", async () => {
    const orgA = await createFixtureOrg(db, { domain: "rel-api-del-a.test" });
    const orgB = await createFixtureOrg(db, { domain: "rel-api-del-b.test" });

    const relationship = await createRelationship(db, {
      organizationId: orgA.org.id,
      actorId: orgA.user.id,
      fromType: "project",
      fromId: orgA.project.id,
      toType: "initiative",
      toId: orgA.initiative.id,
      relationType: "affects",
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/relationships/${relationship.id}`,
      cookies: { [SESSION_COOKIE_NAME]: await tokenFor(orgB) },
    });
    await app.close();
    expect(response.statusCode).toBe(404);
  });

  it("400s POST for an invalid relationType, and 404s for a valid-shaped but nonexistent target", async () => {
    const fixture = await createFixtureOrg(db, { domain: "rel-api-post-bad.test" });
    const app = await buildApp();
    const cookies = { [SESSION_COOKIE_NAME]: await tokenFor(fixture) };

    const badRelationType = await app.inject({
      method: "POST",
      url: "/api/relationships",
      payload: {
        fromType: "project",
        fromId: fixture.project.id,
        toType: "initiative",
        toId: fixture.initiative.id,
        relationType: "not-a-real-type",
      },
      cookies,
    });
    expect(badRelationType.statusCode).toBe(400);

    const missingTarget = await app.inject({
      method: "POST",
      url: "/api/relationships",
      payload: {
        fromType: "project",
        fromId: fixture.project.id,
        toType: "task",
        toId: randomUUID(),
        relationType: "blocks",
      },
      cookies,
    });
    expect(missingTarget.statusCode).toBe(404);

    await app.close();
  });
});
