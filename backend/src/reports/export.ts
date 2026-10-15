import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import {
  companyEntities,
  decisions,
  entityRelationships,
  initiatives,
  milestoneLinks,
  milestones,
  objectives,
  projects,
  risks,
  sources,
  strategicQuestionLinks,
  strategicQuestions,
  suggestions,
  tasks,
} from "../db/schema.js";

// A full, admin-only export of the organization's working records -- every
// status, including merged (superseded), finished and cancelled ones -- for
// reconciling Pulse against an outside review or ledger. Leaves out
// everything sensitive or irrelevant to that: sign-in and integration
// secrets, user accounts, view links, and the text of source emails and
// transcripts (only each source's type, date and id are included).

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function buildExport(db: DbOrTx, organizationId: string) {
  const [objectiveRows, initiativeRows, projectRows, taskRows, decisionRows, milestoneRows, milestoneLinkRows, riskRows, questionRows, questionLinkRows, entityRows, relationshipRows, pendingRows, sourceRows] =
    await Promise.all([
      db.select().from(objectives).where(eq(objectives.organizationId, organizationId)).orderBy(asc(objectives.createdAt)),
      db.select().from(initiatives).where(eq(initiatives.organizationId, organizationId)).orderBy(asc(initiatives.createdAt)),
      db.select().from(projects).where(eq(projects.organizationId, organizationId)).orderBy(asc(projects.createdAt)),
      db.select().from(tasks).where(eq(tasks.organizationId, organizationId)).orderBy(asc(tasks.createdAt)),
      db.select().from(decisions).where(eq(decisions.organizationId, organizationId)).orderBy(asc(decisions.createdAt)),
      db.select().from(milestones).where(eq(milestones.organizationId, organizationId)).orderBy(asc(milestones.createdAt)),
      db.select().from(milestoneLinks).where(eq(milestoneLinks.organizationId, organizationId)),
      db.select().from(risks).where(eq(risks.organizationId, organizationId)).orderBy(asc(risks.createdAt)),
      db.select().from(strategicQuestions).where(eq(strategicQuestions.organizationId, organizationId)).orderBy(asc(strategicQuestions.createdAt)),
      db.select().from(strategicQuestionLinks).where(eq(strategicQuestionLinks.organizationId, organizationId)),
      db.select().from(companyEntities).where(eq(companyEntities.organizationId, organizationId)),
      db.select().from(entityRelationships).where(eq(entityRelationships.organizationId, organizationId)),
      db
        .select()
        .from(suggestions)
        .where(and(eq(suggestions.organizationId, organizationId), inArray(suggestions.status, ["pending", "edited"])))
        .orderBy(asc(suggestions.createdAt)),
      db
        .select({ id: sources.id, type: sources.type, externalId: sources.externalId, receivedAt: sources.receivedAt })
        .from(sources)
        .where(eq(sources.organizationId, organizationId)),
    ]);

  const objectiveTitle = new Map(objectiveRows.map((o) => [o.id, o.title]));
  const initiativeById = new Map(initiativeRows.map((i) => [i.id, i]));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  // Each task with its full place in the hierarchy, so a reviewer can match
  // without joining tables by hand.
  const taskExport = taskRows.map((t) => {
    const project = projectById.get(t.projectId);
    const initiative = project ? initiativeById.get(project.initiativeId) : undefined;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      owner: t.owner,
      outcome: initiative ? (objectiveTitle.get(initiative.objectiveId) ?? null) : null,
      initiative: initiative?.title ?? null,
      project: project?.title ?? null,
      projectId: t.projectId,
      description: t.description,
      latestUpdate: t.latestUpdate,
      nextAction: t.nextAction,
      waitingFor: t.waitingFor,
      dueDate: iso(t.dueDate),
      dueDateType: t.dueDateType,
      dueLabel: t.dueLabel,
      followUpOn: iso(t.followUpOn),
      visibility: t.visibility,
      supersededById: t.supersededById,
      fieldEvidence: t.fieldEvidence,
      createdAt: iso(t.createdAt),
      updatedAt: iso(t.updatedAt),
    };
  });

  return {
    exportedAt: new Date().toISOString(),
    counts: {
      outcomes: objectiveRows.length,
      initiatives: initiativeRows.length,
      projects: projectRows.length,
      tasks: taskRows.length,
      decisions: decisionRows.length,
      milestones: milestoneRows.length,
      risks: riskRows.length,
      strategicQuestions: questionRows.length,
      pendingReviewCards: pendingRows.length,
      sources: sourceRows.length,
    },
    outcomes: objectiveRows,
    initiatives: initiativeRows,
    projects: projectRows,
    tasks: taskExport,
    decisions: decisionRows,
    milestones: milestoneRows,
    milestoneLinks: milestoneLinkRows,
    risks: riskRows,
    strategicQuestions: questionRows,
    strategicQuestionLinks: questionLinkRows,
    entities: entityRows,
    relationships: relationshipRows,
    pendingReviewCards: pendingRows.map((s) => ({
      id: s.id,
      status: s.status,
      targetType: s.targetType,
      targetId: s.targetId,
      changeType: s.changeType,
      proposedDiff: s.proposedDiff,
      reasoning: s.reasoning,
      confidence: s.confidence,
      sourceId: s.sourceId,
      createdAt: iso(s.createdAt),
    })),
    sources: sourceRows,
  };
}

const CSV_COLUMNS = [
  "id",
  "title",
  "status",
  "owner",
  "outcome",
  "initiative",
  "project",
  "nextAction",
  "waitingFor",
  "dueDate",
  "dueDateType",
  "latestUpdate",
  "supersededById",
  "updatedAt",
] as const;

function cell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The tasks alone, one row each, for a spreadsheet.
export function tasksCsv(rows: Awaited<ReturnType<typeof buildExport>>["tasks"]): string {
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(","))].join("\r\n");
}
