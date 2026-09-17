import { eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { UserRole, Visibility } from "../db/schema.js";

// "leadership" and "restricted" both gate on admin -- this app has exactly
// two roles today, so there's no real third enforcement tier to build
// without inventing one (see schema.ts's comment on visibilityEnum).
export function canViewVisibility(role: UserRole, visibility: Visibility): boolean {
  if (visibility === "team") return true;
  return role === "admin";
}

// Splices into a WHERE clause: undefined for an admin (no filter, sees
// everything), or a condition restricting to "team" for a member. Callers
// AND this into their existing org-scoped where() alongside every other
// condition, the same way every other cross-cutting filter in this codebase
// composes.
export function visibilityFilter(role: UserRole, column: PgColumn): SQL | undefined {
  if (role === "admin") return undefined;
  return eq(column, "team");
}
