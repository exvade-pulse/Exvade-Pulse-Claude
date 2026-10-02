import { and, eq, inArray } from "drizzle-orm";
import type { Database, DbOrTx } from "../db/client.js";
import {
  auditLog,
  decisions,
  LIVE_DECISION_STATUSES,
  sources,
  tasks,
  UNDECIDED_DECISION_STATUSES,
  type DecisionStatus,
} from "../db/schema.js";

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
    // Executive overview fields; objectiveId is checked by the caller
    // (overview/manage.ts) against this organization's live objectives.
    objectiveId: string | null;
    recommendation: string | null;
    impactOfDelay: string | null;
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
    // Interpretation is only offered live decisions (see pipeline.ts), so a
    // closed/superseded target means it was finished after the suggestion
    // was drafted -- updating it via an inferred change would undo a
    // deliberate human call.
    if (!LIVE_DECISION_STATUSES.includes(existing.status)) {
      throw new DecisionError(`Decision is already ${existing.status}`, "conflict");
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

interface AddInfoParams {
  organizationId: string;
  decisionId: string;
  actorId: string;
  // The submitting user's email, for the attribution line prefixed onto the
  // appended note -- relevantContext has no per-entry author field of its
  // own, so this is folded into the entry's own text.
  actorLabel: string;
  note: string;
}

// Appends rather than overwrites: relevantContext is a single text field, and
// a decision can accumulate several rounds of new information before anyone
// is ready to decide. Forcing a reviewer to retype the existing context just
// to add one more fact would be both annoying and a good way to accidentally
// drop earlier context.
export async function addDecisionInfo(db: Database, params: AddInfoParams) {
  return db.transaction(async (tx) => {
    const [decision] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, params.decisionId), eq(decisions.organizationId, params.organizationId)));

    if (!decision) {
      throw new DecisionError("Decision not found", "not_found");
    }
    if (!LIVE_DECISION_STATUSES.includes(decision.status)) {
      throw new DecisionError(`Decision is already ${decision.status}`, "conflict");
    }

    const entry = `[${new Date().toISOString().slice(0, 10)} — ${params.actorLabel}] ${params.note}`;
    const relevantContext = decision.relevantContext ? `${decision.relevantContext}\n\n${entry}` : entry;

    const [updated] = await tx
      .update(decisions)
      .set({ relevantContext, updatedAt: new Date() })
      .where(eq(decisions.id, decision.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "decision.info_added",
      entityType: "decision",
      entityId: decision.id,
      details: { note: params.note },
    });

    return updated;
  });
}

interface AssignParams {
  organizationId: string;
  decisionId: string;
  actorId: string;
  decider: string;
}

// Reassigns who is on the hook to decide -- distinct from stakeholders (who
// needs to be consulted/informed, not who owns making the call).
export async function assignDecision(db: Database, params: AssignParams) {
  return db.transaction(async (tx) => {
    const [decision] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, params.decisionId), eq(decisions.organizationId, params.organizationId)));

    if (!decision) {
      throw new DecisionError("Decision not found", "not_found");
    }
    if (!UNDECIDED_DECISION_STATUSES.includes(decision.status)) {
      throw new DecisionError(`Decision is already ${decision.status}`, "conflict");
    }

    const previousDecider = decision.decider;
    const [updated] = await tx
      .update(decisions)
      .set({ decider: params.decider, updatedAt: new Date() })
      .where(eq(decisions.id, decision.id))
      .returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "decision.assigned",
      entityType: "decision",
      entityId: decision.id,
      details: { previousDecider, decider: params.decider },
    });

    return updated;
  });
}

interface ResolveParams {
  organizationId: string;
  decisionId: string;
  actorId: string;
  resolution: string;
  // Opt-in, off by default: when the decision that just resolved was the
  // thing blocking a task, offer to also clear that block in the same write
  // rather than leaving the task stuck until someone notices separately.
  alsoUnblockTask?: boolean;
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
    if (!UNDECIDED_DECISION_STATUSES.includes(decision.status)) {
      throw new DecisionError(`Decision is already ${decision.status}`, "conflict");
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

    let unblockedTask: typeof tasks.$inferSelect | null = null;

    // Only ever auto-clears `blocked`, never `needs_attention` -- blocked is
    // the direct "waiting on a decision" signal a decision can concretely
    // resolve; needs_attention is a much weaker/broader signal (could mean
    // anything from "stale" to "confusing update") that this one decision
    // resolving shouldn't be presumed to fix. Leave that to a human.
    if (params.alsoUnblockTask && decision.relatedTaskId) {
      const [relatedTask] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, decision.relatedTaskId), eq(tasks.organizationId, params.organizationId)));

      if (relatedTask && relatedTask.status === "blocked") {
        const [taskUpdated] = await tx
          .update(tasks)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(tasks.id, relatedTask.id))
          .returning();
        unblockedTask = taskUpdated;

        await tx.insert(auditLog).values({
          organizationId: params.organizationId,
          actorId: params.actorId,
          action: "task.unblocked_via_decision",
          entityType: "task",
          entityId: relatedTask.id,
          details: { decisionId: decision.id, previousStatus: "blocked", newStatus: "active" },
        });
      }
    }

    return { decision: updated, unblockedTask };
  });
}

// Which lifecycle moves a person can make directly. "decided" is reached
// only via resolveDecision (it records the resolution); "superseded" only
// via supersedeDecision (it records what replaced it).
const ALLOWED_TRANSITIONS: Partial<Record<DecisionStatus, DecisionStatus[]>> = {
  open: ["pending_info", "closed"],
  pending_info: ["open", "closed"],
  decided: ["action_in_progress", "closed"],
  action_in_progress: ["closed"],
};

export const SETTABLE_DECISION_STATUSES: DecisionStatus[] = ["open", "pending_info", "action_in_progress", "closed"];

interface SetStatusParams {
  organizationId: string;
  decisionId: string;
  actorId: string;
  status: DecisionStatus;
  // Required when closing a decision that was never made (why it was
  // closed is the only record of what happened); optional otherwise.
  note?: string | null;
}

export async function setDecisionStatus(db: Database, params: SetStatusParams) {
  return db.transaction(async (tx) => {
    const [decision] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, params.decisionId), eq(decisions.organizationId, params.organizationId)));

    if (!decision) {
      throw new DecisionError("Decision not found", "not_found");
    }
    const allowed = ALLOWED_TRANSITIONS[decision.status] ?? [];
    if (!allowed.includes(params.status)) {
      throw new DecisionError(`Can't move a decision from ${decision.status} to ${params.status}`, "conflict");
    }
    const note = params.note?.trim() || null;
    if (params.status === "closed" && UNDECIDED_DECISION_STATUSES.includes(decision.status) && !note) {
      throw new DecisionError("Closing a decision that was never made needs a note saying what happened", "conflict");
    }

    const set: Partial<typeof decisions.$inferInsert> = { status: params.status, updatedAt: new Date() };
    if (note && params.status === "closed") {
      const entry = `[${new Date().toISOString().slice(0, 10)} — closed] ${note}`;
      set.resolution = decision.resolution ? `${decision.resolution}\n\n${entry}` : entry;
    }

    const [updated] = await tx.update(decisions).set(set).where(eq(decisions.id, decision.id)).returning();

    await tx.insert(auditLog).values({
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "decision.status_changed",
      entityType: "decision",
      entityId: decision.id,
      details: { from: decision.status, to: params.status, note },
    });

    return updated;
  });
}

interface SupersedeParams {
  organizationId: string;
  // The duplicate: kept as a record, marked superseded.
  decisionId: string;
  // The canonical decision it's merged into.
  supersededById: string;
  actorId: string;
}

// Merges a duplicate into its canonical decision without deleting anything:
// the duplicate is marked superseded and points at the canonical one, and
// whatever the duplicate knew that the canonical didn't (its reasoning and
// context, a due date, stakeholders, a related task) is copied over. The
// duplicate's own row, history and audit trail stay intact.
export async function supersedeDecision(db: DbOrTx, params: SupersedeParams) {
  return db.transaction(async (tx) => {
    if (params.decisionId === params.supersededById) {
      throw new DecisionError("A decision can't supersede itself", "conflict");
    }
    const rows = await tx
      .select()
      .from(decisions)
      .where(
        and(eq(decisions.organizationId, params.organizationId), inArray(decisions.id, [params.decisionId, params.supersededById])),
      );
    const duplicate = rows.find((d) => d.id === params.decisionId);
    const keep = rows.find((d) => d.id === params.supersededById);
    if (!duplicate || !keep) {
      throw new DecisionError("Decision not found", "not_found");
    }
    if (duplicate.status === "superseded" || duplicate.status === "closed") {
      throw new DecisionError(`The duplicate is already ${duplicate.status}`, "conflict");
    }
    if (keep.status === "superseded") {
      throw new DecisionError("The decision to keep has itself been superseded", "conflict");
    }

    const today = new Date().toISOString().slice(0, 10);
    const carried = [duplicate.whyItMatters, duplicate.relevantContext, duplicate.suggestedNextStep]
      .filter((text): text is string => !!text && !(keep.relevantContext ?? "").includes(text) && text !== keep.whyItMatters)
      .join("\n");
    const mergeEntry = `[${today} — merged from duplicate "${duplicate.title}"]${carried ? ` ${carried}` : ""}`;
    const keepPatch: Partial<typeof decisions.$inferInsert> = {
      relevantContext: keep.relevantContext ? `${keep.relevantContext}\n\n${mergeEntry}` : mergeEntry,
      stakeholders: [...new Set([...keep.stakeholders, ...duplicate.stakeholders])],
      updatedAt: new Date(),
    };
    if (!keep.dueDate && duplicate.dueDate) keepPatch.dueDate = duplicate.dueDate;
    if (!keep.relatedTaskId && duplicate.relatedTaskId) keepPatch.relatedTaskId = duplicate.relatedTaskId;

    const [kept] = await tx.update(decisions).set(keepPatch).where(eq(decisions.id, keep.id)).returning();
    const [superseded] = await tx
      .update(decisions)
      .set({ status: "superseded", supersededById: keep.id, updatedAt: new Date() })
      .where(eq(decisions.id, duplicate.id))
      .returning();

    await tx.insert(auditLog).values([
      {
        organizationId: params.organizationId,
        actorId: params.actorId,
        action: "decision.superseded",
        entityType: "decision",
        entityId: duplicate.id,
        details: { supersededById: keep.id, previousStatus: duplicate.status },
      },
      {
        organizationId: params.organizationId,
        actorId: params.actorId,
        action: "decision.merged_into",
        entityType: "decision",
        entityId: keep.id,
        details: { duplicateId: duplicate.id, duplicateTitle: duplicate.title },
      },
    ]);

    return { kept, superseded };
  });
}
