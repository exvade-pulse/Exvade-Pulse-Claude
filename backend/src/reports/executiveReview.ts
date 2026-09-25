import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { decisions, sources, suggestions, tasks, type UserRole } from "../db/schema.js";
import { visibilityFilter } from "../access/visibility.js";
import { loadCompanyMapTree } from "../routes/companyMap.js";
import { describeSuggestions } from "../suggestions/describe.js";

// A plain-text snapshot of the whole org, written for an outside assistant
// (the user's own ChatGPT) to review with its own context about the
// company. Deterministic -- no Claude call -- and it only reports what Pulse
// actually records: it says "none recorded" rather than inventing deadlines
// or owners it doesn't have.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 14;
const STALE_DAYS = 30;
const RECENT_LIMIT = 50;
const REVIEW_LIMIT = 100;
const TERMINAL_STATUSES = new Set(["completed", "resolved", "superseded"]);
const STATUS_ORDER = ["blocked", "needs_attention", "waiting", "active"];
const PRIORITY_ORDER = ["critical", "high", "medium", "low"];

const SOURCE_LABEL: Record<string, string> = {
  gmail: "email",
  circleback: "meeting",
  document: "document",
  manual: "note",
  chatgpt: "ChatGPT",
};

function formatDate(date: Date | string | null): string {
  if (!date) return "unknown";
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function daysSince(date: Date | string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / MS_PER_DAY));
}

function statusLabel(status: string): string {
  return status.replace("_", " ").toUpperCase();
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function summarizeDiff(diff: Record<string, unknown>): string {
  return Object.entries(diff)
    .filter(([key, value]) => !key.endsWith("Id") && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${clip(Array.isArray(value) ? value.join(", ") : String(value), 160)}`)
    .join("; ");
}

export async function buildExecutiveReview(organizationId: string, role: UserRole, now = new Date()): Promise<string> {
  const recentSince = new Date(now.getTime() - RECENT_DAYS * MS_PER_DAY);

  const [tree, openDecisions, recentRows, pendingRows] = await Promise.all([
    loadCompanyMapTree(organizationId, role),
    db
      .select({
        id: decisions.id,
        title: decisions.title,
        decider: decisions.decider,
        stakeholders: decisions.stakeholders,
        dueDate: decisions.dueDate,
        whyItMatters: decisions.whyItMatters,
        relevantContext: decisions.relevantContext,
        suggestedNextStep: decisions.suggestedNextStep,
        relatedTaskId: decisions.relatedTaskId,
      })
      .from(decisions)
      .where(and(eq(decisions.organizationId, organizationId), eq(decisions.status, "open"), visibilityFilter(role, decisions.visibility)))
      .orderBy(sql`${decisions.dueDate} is null`, decisions.dueDate),
    // "Recent" by when the evidence is dated (the source's receivedAt), not
    // when it was imported -- a 2019 document approved yesterday isn't news.
    db
      .select({
        id: suggestions.id,
        targetType: suggestions.targetType,
        targetId: suggestions.targetId,
        proposedDiff: suggestions.proposedDiff,
        sourceType: sources.type,
        receivedAt: sources.receivedAt,
      })
      .from(suggestions)
      .innerJoin(sources, eq(sources.id, suggestions.sourceId))
      .where(
        and(
          eq(suggestions.organizationId, organizationId),
          eq(suggestions.status, "approved"),
          gte(sources.receivedAt, recentSince),
        ),
      )
      .orderBy(desc(sources.receivedAt))
      .limit(RECENT_LIMIT),
    db
      .select({
        id: suggestions.id,
        targetType: suggestions.targetType,
        targetId: suggestions.targetId,
        changeType: suggestions.changeType,
        proposedDiff: suggestions.proposedDiff,
        reasoning: suggestions.reasoning,
        confidence: suggestions.confidence,
      })
      .from(suggestions)
      .where(and(eq(suggestions.organizationId, organizationId), inArray(suggestions.status, ["pending", "edited"])))
      .orderBy(desc(suggestions.confidence))
      .limit(REVIEW_LIMIT),
  ]);

  // Flatten the tree, keeping each open task's place in the hierarchy.
  type TreeObjective = (typeof tree)[number];
  type TreeInitiative = TreeObjective["initiatives"][number];
  type TreeProject = NonNullable<TreeInitiative["projects"]>[number];
  type TreeTask = TreeProject["tasks"][number];
  interface PlacedTask {
    task: TreeTask;
    objective: TreeObjective;
    initiative: TreeInitiative;
    project: TreeProject;
  }
  const openTasks: PlacedTask[] = [];
  for (const objective of tree) {
    for (const initiative of objective.initiatives) {
      for (const project of initiative.projects ?? []) {
        for (const task of project.tasks) {
          if (!TERMINAL_STATUSES.has(task.status)) openTasks.push({ task, objective, initiative, project });
        }
      }
    }
  }

  // A member's report must not leak a restricted task or decision through
  // the review/recent sections either, only the ones they can see.
  const visibleTaskIds = new Set<string>();
  if (role !== "admin") {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.organizationId, organizationId), visibilityFilter(role, tasks.visibility)));
    for (const row of rows) visibleTaskIds.add(row.id);
  }
  const visibleDecisionIds = new Set(openDecisions.map((d) => d.id));
  const canSee = (row: { targetType: string; targetId: string | null; proposedDiff: unknown }): boolean => {
    if (role === "admin") return true;
    const ids: Array<[string, unknown]> = [];
    if (row.targetType === "relationship") {
      const diff = row.proposedDiff as Record<string, unknown>;
      ids.push([String(diff.fromType), diff.fromId], [String(diff.toType), diff.toId]);
    } else if (row.targetId) {
      ids.push([row.targetType, row.targetId]);
    }
    return ids.every(([type, id]) => {
      if (type === "task") return visibleTaskIds.has(String(id));
      if (type === "decision") return visibleDecisionIds.has(String(id));
      return true;
    });
  };
  const recent = recentRows.filter(canSee);
  const pending = pendingRows.filter(canSee);
  const about = await describeSuggestions(db, organizationId, [...recent, ...pending]);

  const taskTitleById = new Map(openTasks.map((p) => [p.task.id, p.task.title]));
  const byStatusThenTitle = (a: PlacedTask, b: PlacedTask) =>
    STATUS_ORDER.indexOf(a.task.status) - STATUS_ORDER.indexOf(b.task.status) || a.task.title.localeCompare(b.task.title);
  const taskLine = (p: PlacedTask, includePath: boolean) => {
    const parts = [`- [${statusLabel(p.task.status)}] ${p.task.title}`];
    if (includePath) parts.push(`(${p.objective.title} › ${p.project.title})`);
    const details = [
      `Owner: ${p.task.owner ?? "not recorded"}`,
      `Last updated: ${formatDate(p.task.updatedAt)}`,
    ];
    if (p.task.nextAction) details.push(`Next: ${clip(p.task.nextAction, 200)}`);
    return `${parts.join(" ")}\n    ${details.join(" | ")}`;
  };

  const lines: string[] = [];
  const counts = (status: string) => openTasks.filter((p) => p.task.status === status).length;
  const overdueDecisions = openDecisions.filter((d) => d.dueDate && new Date(d.dueDate).getTime() < now.getTime());

  lines.push(
    "EXVADE PULSE — EXECUTIVE REVIEW",
    `Generated: ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    "This is a snapshot of Exvade Bioscience's operations tracker (Pulse). Please review it using what you know about Exvade: what should I focus on, what am I missing, which decisions need attention, and what should happen next? Anything I paste back into Pulse goes to a review queue for approval before it changes anything.",
    "",
    `At a glance: ${openTasks.length} open tasks (${counts("blocked")} blocked, ${counts("needs_attention")} need attention, ${counts("waiting")} waiting) · ${openDecisions.length} open decisions (${overdueDecisions.length} overdue) · ${pending.length} suggestions awaiting review.`,
    "Note: Pulse doesn't record due dates on tasks (only on decisions). Owners are shown where known.",
  );

  // 1. Current priorities
  lines.push("", "1. CURRENT PRIORITIES", "Open tasks under Critical- or High-priority objectives:");
  const priorityTasks = openTasks
    .filter((p) => p.objective.priority === "critical" || p.objective.priority === "high")
    .sort(
      (a, b) =>
        PRIORITY_ORDER.indexOf(a.objective.priority) - PRIORITY_ORDER.indexOf(b.objective.priority) || byStatusThenTitle(a, b),
    );
  if (priorityTasks.length === 0) lines.push("- None.");
  for (const p of priorityTasks) lines.push(taskLine(p, true));

  // 2. Outstanding decisions
  lines.push("", "2. OUTSTANDING DECISIONS");
  if (openDecisions.length === 0) lines.push("- None.");
  for (const d of openDecisions) {
    const due = d.dueDate
      ? `due ${formatDate(d.dueDate)}${new Date(d.dueDate).getTime() < now.getTime() ? " — OVERDUE" : ""}`
      : "no due date recorded";
    lines.push(`- ${d.title}`, `    Decider: ${d.decider} | ${due}`);
    if (d.stakeholders.length > 0) lines.push(`    Stakeholders: ${d.stakeholders.join(", ")}`);
    if (d.whyItMatters) lines.push(`    Why it matters: ${clip(d.whyItMatters, 500)}`);
    if (d.relevantContext) lines.push(`    Context: ${clip(d.relevantContext, 500)}`);
    if (d.suggestedNextStep) lines.push(`    Suggested next step: ${clip(d.suggestedNextStep, 300)}`);
    if (d.relatedTaskId && taskTitleById.has(d.relatedTaskId)) lines.push(`    Related task: ${taskTitleById.get(d.relatedTaskId)}`);
  }

  // 3. Blocked or overdue
  lines.push("", "3. BLOCKED, STUCK OR OVERDUE");
  const stuck = openTasks.filter((p) => p.task.status !== "active").sort(byStatusThenTitle);
  const stale = openTasks
    .filter((p) => p.task.status === "active" && daysSince(p.task.updatedAt, now) >= STALE_DAYS)
    .sort((a, b) => new Date(a.task.updatedAt).getTime() - new Date(b.task.updatedAt).getTime());
  if (stuck.length === 0 && stale.length === 0 && overdueDecisions.length === 0) lines.push("- Nothing blocked, stuck or overdue.");
  for (const p of stuck) {
    const blockedBy = p.task.blockingDecision ? ` | Waiting on decision: ${p.task.blockingDecision.title}` : "";
    lines.push(`${taskLine(p, true)}\n    No update in ${daysSince(p.task.updatedAt, now)} days${blockedBy}`);
  }
  if (stale.length > 0) {
    lines.push(`Active tasks with no update in ${STALE_DAYS}+ days:`);
    for (const p of stale) lines.push(`${taskLine(p, true)}\n    No update in ${daysSince(p.task.updatedAt, now)} days`);
  }
  for (const d of overdueDecisions) lines.push(`- Overdue decision: ${d.title} (was due ${formatDate(d.dueDate)}, decider: ${d.decider})`);

  // 4. Recent developments
  lines.push("", `4. RECENT DEVELOPMENTS (approved updates dated in the last ${RECENT_DAYS} days)`);
  if (recent.length === 0) lines.push("- None.");
  for (const row of recent) {
    // A relationship's "about" line already says everything its diff would.
    const summary = row.targetType === "relationship" ? "" : summarizeDiff(row.proposedDiff as Record<string, unknown>);
    lines.push(
      `- ${formatDate(row.receivedAt)} · ${about.get(row.id)} (from ${SOURCE_LABEL[row.sourceType] ?? row.sourceType})${summary ? `\n    ${summary}` : ""}`,
    );
  }

  // 5. Awaiting review
  lines.push("", "5. AWAITING REVIEW IN PULSE (proposed changes not yet approved)");
  if (pending.length === 0) lines.push("- None.");
  for (const row of pending) {
    lines.push(
      `- ${about.get(row.id)} — ${row.changeType.replace("_", " ")}, ${Math.round(row.confidence * 100)}% confidence`,
      `    Why: ${clip(row.reasoning, 240)}`,
    );
  }

  // 6. Full task inventory
  lines.push("", "6. FULL OPEN-TASK INVENTORY (by objective › initiative › project)");
  if (openTasks.length === 0) lines.push("- No open tasks.");
  for (const objective of tree) {
    const objectiveTasks = openTasks.filter((p) => p.objective.id === objective.id);
    lines.push("", `${objective.title} [${objective.priority} priority, ${objective.status}]`);
    if (objectiveTasks.length === 0) {
      lines.push("  (no open tasks)");
      continue;
    }
    for (const initiative of objective.initiatives) {
      for (const project of initiative.projects ?? []) {
        const projectTasks = objectiveTasks.filter((p) => p.project.id === project.id).sort(byStatusThenTitle);
        if (projectTasks.length === 0) continue;
        lines.push(`  ${initiative.title} › ${project.title}`);
        for (const p of projectTasks) {
          lines.push(`  ${taskLine(p, false)}`);
          if (p.task.latestUpdate) lines.push(`      Latest: ${clip(p.task.latestUpdate, 300)}`);
        }
      }
    }
  }

  return lines.join("\n");
}
