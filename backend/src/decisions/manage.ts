import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
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

export async function createDecision(db: Database, params: CreateParams) {
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
