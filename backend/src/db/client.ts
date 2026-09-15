import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import * as schema from "./schema.js";

export function createDb(connectionString: string) {
  const client = postgres(connectionString, { max: 10 });
  return { client, db: drizzle(client, { schema }) };
}

const { client, db } = createDb(config.databaseUrl || "postgres://placeholder");

export { client, db };
export type Database = ReturnType<typeof createDb>["db"];
