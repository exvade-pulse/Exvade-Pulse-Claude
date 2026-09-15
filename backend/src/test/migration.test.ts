import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "./helpers.js";
import * as schema from "../db/schema.js";

const { db, client } = testDb();

describe("migrations", () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await client.end();
  });

  it("creates every core table and they are queryable", async () => {
    await expect(db.select().from(schema.organizations)).resolves.toEqual([]);
    await expect(db.select().from(schema.users)).resolves.toEqual([]);
    await expect(db.select().from(schema.objectives)).resolves.toEqual([]);
    await expect(db.select().from(schema.initiatives)).resolves.toEqual([]);
    await expect(db.select().from(schema.projects)).resolves.toEqual([]);
    await expect(db.select().from(schema.tasks)).resolves.toEqual([]);
    await expect(db.select().from(schema.sources)).resolves.toEqual([]);
    await expect(db.select().from(schema.suggestions)).resolves.toEqual([]);
    await expect(db.select().from(schema.auditLog)).resolves.toEqual([]);
  });
});
