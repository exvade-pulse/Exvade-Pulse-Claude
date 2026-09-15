import { createDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { sql } from "drizzle-orm";

export function testDb() {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL (or DATABASE_URL) must be set to run tests.");
  }
  return createDb(connectionString);
}

const TABLES = [
  schema.auditLog,
  schema.decisions,
  schema.suggestions,
  schema.sources,
  schema.tasks,
  schema.projects,
  schema.initiatives,
  schema.objectives,
  schema.users,
  schema.organizations,
];

export async function truncateAll(db: ReturnType<typeof createDb>["db"]) {
  for (const table of TABLES) {
    await db.execute(sql`truncate table ${table} cascade`);
  }
}
