import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import * as schema from "./schema.js";

export function createDb(connectionString: string) {
  // Explicit, not relying on the connecting role's default search_path:
  // Neon's pooler can hand back a physical connection whose session state
  // (including search_path) was left behind by a prior, unrelated client --
  // e.g. a psql session running a plain SQL dump/restore, whose preamble
  // resets search_path to empty. Setting it here sends it as a startup
  // parameter on every connection this pool opens, so query results never
  // depend on what state some previous occupant of a pooled connection left.
  const client = postgres(connectionString, { max: 10, connection: { search_path: "public" } });
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
