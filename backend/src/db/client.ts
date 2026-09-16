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

// The transaction handle a `db.transaction(async (tx) => ...)` callback receives.
// A function that needs to be callable both standalone and from inside a caller's
// existing transaction (e.g. decisions/manage.ts's createDecision, invoked from
// suggestions/apply.ts's approveSuggestion) should accept `DbOrTx` instead of just
// `Database` -- postgres-js implements a nested `tx.transaction()` call as a
// savepoint, so this composes correctly rather than opening an unrelated second
// top-level transaction.
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Transaction;
