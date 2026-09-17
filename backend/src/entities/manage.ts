import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { companyEntities } from "../db/schema.js";

export interface CreateCompanyEntityParams {
  organizationId: string;
  name: string;
  kind?: string | null;
  notes?: string | null;
}

export async function createCompanyEntity(db: Database, params: CreateCompanyEntityParams) {
  const [entity] = await db
    .insert(companyEntities)
    .values({
      organizationId: params.organizationId,
      name: params.name,
      kind: params.kind ?? null,
      notes: params.notes ?? null,
    })
    .returning();
  return entity;
}

export async function listCompanyEntities(db: Database, organizationId: string) {
  return db
    .select()
    .from(companyEntities)
    .where(eq(companyEntities.organizationId, organizationId))
    .orderBy(asc(companyEntities.name));
}
