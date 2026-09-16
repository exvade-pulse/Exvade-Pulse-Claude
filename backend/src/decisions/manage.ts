import { and, eq } from "drizzle-orm";
import type { Database, DbOrTx } from "../db/client.js";
import { auditLog, decisions, sources, tasks } from "../db/schema.js";

export class DecisionError extends Error {
  code: "not_found" | "conflict";

  constructor(message: string, code: "not_found" | "conflict") {
    super(message);
    this.code = code;
  }
}

interface CreateParams {
  organizationId: string;
  actorId: string;
  title: string;
  whyItMatters?: string | null;
  relevantContext?: string | null;
  suggestedNextStep?: string | null;
  decider: string;
  stakeholders?: string[];
  dueDate?: Date | null;
  relatedTaskId?: string | null;
  sourceId?: string | null;
}

// Accepts DbOrTx (not just Database) so suggestions/apply.ts's approveSuggestion
// can call this from inside its own transaction -- via a postgres savepoint --
// instead of duplicating this function's org-scoped validation and audit-log
// write for the decision-suggestion approval path.
export async function createDecision(db: DbOrTx, params: CreateParams) {
  return db.transaction(async (tx) => {
    if (params.relatedTaskId) {
      const [task] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, params.relatedTaskId), eq(tasks.organizationId, params.organizationId)));
      if (!task) {
        throw new DecisionError("relatedTaskId does not belong to this organization", "not_found");
      }
    }

    if (params.sourceId) {
      const [source] = await tx
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.id, params.sourceId), eq(sources.organizationId, params.organizationId)));
      if (!source) {
        throw new DecisionError("sourceId does not belong to this organization", "not_found");
      }
    }

    const [decision] = await tx
      .insert(decisions)
      .values({
        organizationId: params.organizationId,
        title: params.title,
        whyItMatters: params.whyItMatters ?? null,
        relevantContext: params.relevantContext ?? null,
        suggestedNextStep: params.suggestedNextStep ?? null,
        decider: params.decider,
        stakeholders: params.stakeholders ?? [],
        dueDate: params.dueDate ?? null,
        relatedTaskId: params.relatedTaskId ?? null,
        sourceId: params.sourceId ?? null,
      })
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "decision.created",
      entityType: "decision",
      entityId: decision.id,
      details: { title: decision.title, decider: decision.decider },
    });

    return decision;
  });
}

interface UpdateParams {
  organizationId: string;
  decisionId: string;
  actorId: string;
  fields: Partial<{
    title: string;
    whyItMatters: string | null;
    relevantContext: string | null;
    suggestedNextStep: string | null;
    decider: string;
    stakeholders: string[];
    dueDate: Date | null;
    relatedTaskId: string | null;
  }>;
}

// Accepts DbOrTx for the same reason createDecision does -- approveSuggestion
// calls this from inside its own transaction when a decision-shaped source
// turns out to be a follow-up on an already-open decision rather than
// something brand new (see interpret.ts's decision-matching guidance).
export async function updateDecision(db: DbOrTx, params: UpdateParams) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, params.decisionId), eq(decisions.organizationId, params.organizationId)));

    if (!existing) {
      throw new DecisionError("Decision not found", "not_found");
    }
    // A decided decision is closed; an interpretation match is only ever
    // offered `open` decisions to begin with (see pipeline.ts), so reaching
    // this with an already-decided target means the decision resolved after
    // the suggestion was drafted -- reopening it via an inferred update would
    // undo a deliberate human resolution.
    if (existing.status !== "open") {
      throw new DecisionError("Decision is already decided", "conflict");
    }

    if (params.fields.relatedTaskId) {
      const [task] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, params.fields.relatedTaskId), eq(tasks.organizationId, params.organizationId)));
      if (!task) {
        throw new DecisionError("relatedTaskId does not belong to this organization", "not_found");
      }
    }

    const [updated] = await tx
      .update(decisions)
      .set({ ...params.fields, updatedAt: new Date() })
      .where(eq(decisions.id, existing.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "decision.updated",
      entityType: "decision",
      entityId: existing.id,
      details: { updatedFields: params.fields },
    });

    return updated;
  });
}

interface ResolveParams {
  organizationId: string;
  decisionId: string;
  actorId: string;
  resolution: string;
}

export async function resolveDecision(db: Database, params: ResolveParams) {
  return db.transaction(async (tx) => {
    const [decision] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, params.decisionId), eq(decisions.organizationId, params.organizationId)));

    if (!decision) {
      throw new DecisionError("Decision not found", "not_found");
    }
    if (decision.status !== "open") {
      throw new DecisionError("Decision is already decided", "conflict");
    }

    const [updated] = await tx
      .update(decisions)
      .set({
        status: "decided",
        resolution: params.resolution,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(decisions.id, decision.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "decision.resolved",
      entityType: "decision",
      entityId: decision.id,
      details: { resolution: params.resolution },
    });

    return updated;
  });
}
