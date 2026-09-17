import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to run migrations");
  }
  // Without a timeout, a bad connection string or blocked network path hangs
  // this forever with zero output -- on a host with no pre-deploy hook (see
  // Dockerfile's CMD comment), that looks identical to a slow build from the
  // outside. Fail loud and fast instead.
  const client = postgres(connectionString, { max: 1, connect_timeout: 10 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await client.end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
