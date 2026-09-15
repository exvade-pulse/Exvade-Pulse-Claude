import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Runs once before the whole test suite: applies every migration in ./drizzle
// against TEST_DATABASE_URL (or DATABASE_URL), proving migrations apply cleanly
// and giving every test file a schema to run against.
export default async function globalSetup() {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "TEST_DATABASE_URL (or DATABASE_URL) must be set to a disposable Postgres database to run tests.",
    );
  }
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await client.end();
}
