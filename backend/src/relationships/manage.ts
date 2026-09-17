import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  companyEntities,
  decisions,
  entityRelationships,
  initiatives,
  objectives,
  projects,
  tasks,
  type EntityNodeType,
  type RelationType,
} from "../db/schema.js";

export class RelationshipError extends Error {
  code: "not_found" | "validation";

  constructor(message: string, code: "not_found" | "validation") {
    super(message);
    this.code = code;
  }
}

// Every entityType except company_entity shares the same {id, organizationId,
// title} shape, so existence checks and name resolution can loop over this
// map generically; company_entity is handled as its own branch everywhere
// (it has `name`, not `title`, and lives in its own table).
const TITLE_TABLE = {
  objective: objectives,
  initiative: initiatives,
  project: projects,
  task: tasks,
  decision: decisions,
} as const;

async function entityExists(
  db: Database,
  organizationId: string,
  type: EntityNodeType,
  id: string,
): Promise<boolean> {
  if (type === "company_entity") {
    const [row] = await db
      .select({ id: companyEntities.id })
      .from(companyEntities)
      .where(and(eq(companyEntities.id, id), eq(companyEntities.organizationId, organizationId)));
    return row !== undefined;
  }
  const table = TITLE_TABLE[type];
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.organizationId, organizationId)));
  return row !== undefined;
}

// Batch name resolution for a set of (type, id) refs, grouped by type so this
// is a handful of queries total, not N+1 per relationship.
async function resolveNames(
  db: Database,
  organizationId: string,
  refs: Array<{ type: EntityNodeType; id: string }>,
): Promise<Map<string, string>> {
  const idsByType = new Map<EntityNodeType, Set<string>>();
  for (const ref of refs) {
    const set = idsByType.get(ref.type) ?? new Set<string>();
    set.add(ref.id);
    idsByType.set(ref.type, set);
  }

  const result = new Map<string, string>();
  await Promise.all(
    [...idsByType.entries()].map(async ([type, idSet]) => {
      const ids = [...idSet];
      if (type === "company_entity") {
        const rows = await db
          .select({ id: companyEntities.id, name: companyEntities.name })
          .from(companyEntities)
          .where(and(eq(companyEntities.organizationId, organizationId), inArray(companyEntities.id, ids)));
        for (const row of rows) result.set(`company_entity:${row.id}`, row.name);
        return;
      }
      const table = TITLE_TABLE[type];
      const rows = await db
        .select({ id: table.id, title: table.title })
        .from(table)
        .where(and(eq(table.organizationId, organizationId), inArray(table.id, ids)));
      for (const row of rows) result.set(`${type}:${row.id}`, row.title);
    }),
  );
  return result;
}

export interface CreateRelationshipParams {
  organizationId: string;
  actorId: string;
  fromType: EntityNodeType;
  fromId: string;
  toType: EntityNodeType;
  toId: string;
  relationType: RelationType;
  note?: string | null;
}

// Both ends must already exist and belong to this org before the edge is
// allowed -- fromId/toId carry no FK constraint at the schema level (a single
// column can't reference six different tables), so this application-level
// check is the only thing standing between a relationship and a dangling
// pointer at another org's data (or nothing at all).
export async function createRelationship(db: Database, params: CreateRelationshipParams) {
  if (params.fromType === params.toType && params.fromId === params.toId) {
    throw new RelationshipError("A relationship cannot link an entity to itself", "validation");
  }

  const [fromOk, toOk] = await Promise.all([
    entityExists(db, params.organizationId, params.fromType, params.fromId),
    entityExists(db, params.organizationId, params.toType, params.toId),
  ]);
  if (!fromOk) {
    throw new RelationshipError(`fromId does not belong to this organization (fromType: ${params.fromType})`, "not_found");
  }
  if (!toOk) {
    throw new RelationshipError(`toId does not belong to this organization (toType: ${params.toType})`, "not_found");
  }

  const [row] = await db
    .insert(entityRelationships)
    .values({
      organizationId: params.organizationId,
      fromType: params.fromType,
      fromId: params.fromId,
      toType: params.toType,
      toId: params.toId,
      relationType: params.relationType,
      note: params.note ?? null,
      createdBy: params.actorId,
    })
    .returning();
  return row;
}

export interface RelationshipView {
  id: string;
  relationType: RelationType;
  // Relative to the entity that was queried for -- "outgoing" means the
  // queried entity is the `from` side (e.g. "this task depends_on X"),
  // "incoming" means it's the `to` side (e.g. "Y depends_on this task").
  direction: "outgoing" | "incoming";
  otherType: EntityNodeType;
  otherId: string;
  otherName: string;
  note: string | null;
  createdAt: Date;
}

// Every relationship touching this entity, on either side -- a task that
// "depends_on" a decision and a decision that's "awaiting_response_from" a
// company entity both show up when querying either endpoint, oriented
// relative to whichever entity was asked about.
export async function listRelationshipsForEntity(
  db: Database,
  organizationId: string,
  entityType: EntityNodeType,
  entityId: string,
): Promise<RelationshipView[]> {
  const rows = await db
    .select()
    .from(entityRelationships)
    .where(
      and(
        eq(entityRelationships.organizationId, organizationId),
        or(
          and(eq(entityRelationships.fromType, entityType), eq(entityRelationships.fromId, entityId)),
          and(eq(entityRelationships.toType, entityType), eq(entityRelationships.toId, entityId)),
        ),
      ),
    )
    .orderBy(desc(entityRelationships.createdAt));

  const otherRefs = rows.map((row) => {
    const outgoing = row.fromType === entityType && row.fromId === entityId;
    return outgoing ? { type: row.toType, id: row.toId } : { type: row.fromType, id: row.fromId };
  });
  const names = await resolveNames(db, organizationId, otherRefs);

  return rows.map((row, i) => {
    const outgoing = row.fromType === entityType && row.fromId === entityId;
    const other = otherRefs[i];
    return {
      id: row.id,
      relationType: row.relationType,
      direction: outgoing ? "outgoing" : "incoming",
      otherType: other.type,
      otherId: other.id,
      otherName: names.get(`${other.type}:${other.id}`) ?? "(unknown)",
      note: row.note,
      createdAt: row.createdAt,
    };
  });
}

export async function deleteRelationship(
  db: Database,
  organizationId: string,
  relationshipId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(entityRelationships)
    .where(and(eq(entityRelationships.id, relationshipId), eq(entityRelationships.organizationId, organizationId)))
    .returning({ id: entityRelationships.id });
  return deleted.length > 0;
}
