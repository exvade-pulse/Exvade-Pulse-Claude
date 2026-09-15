import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  real,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Every top-level table carries organization_id directly (denormalized) so the
// backend query layer can scope any query with a single `eq(table.organizationId, ...)`
// filter, without needing to join up the hierarchy to check tenancy. There is one
// organization today (Exvade Bioscience), but the isolation is enforced now so it
// doesn't need to be retrofitted later.

export const priorityEnum = pgEnum("priority", ["low", "medium", "high", "critical"]);

export const strategyStatusEnum = pgEnum("strategy_status", [
  "active",
  "paused",
  "completed",
  "cancelled",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "active",
  "waiting",
  "needs_attention",
  "completed",
  "superseded",
  "resolved",
  "blocked",
]);

export const sourceTypeEnum = pgEnum("source_type", ["gmail", "circleback"]);

export const targetTypeEnum = pgEnum("target_type", [
  "objective",
  "initiative",
  "project",
  "task",
]);

export const changeTypeEnum = pgEnum("change_type", [
  "operational_update",
  "context",
  "new_task",
  "decision",
  "deadline",
  "resolved",
]);

export const suggestionStatusEnum = pgEnum("suggestion_status", [
  "pending",
  "approved",
  "edited",
  "rejected",
]);

export const decisionStatusEnum = pgEnum("decision_status", ["open", "decided"]);

export const userRoleEnum = pgEnum("user_role", ["member", "admin"]);
export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  googleId: text("google_id").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The allowlist: someone can be authorized before they've ever signed in (no
// users row yet), and role lives solely here -- looked up fresh on each
// authenticated request in requireAuth -- rather than duplicated onto `users`
// where it could go stale after a revoke/role-change.
export const authorizedUsers = pgTable(
  "authorized_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: userRoleEnum("role").notNull().default("member"),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("authorized_users_org_email_unique").on(table.organizationId, table.email)],
);

export const objectives = pgTable("objectives", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: strategyStatusEnum("status").notNull().default("active"),
  priority: priorityEnum("priority").notNull().default("medium"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const initiatives = pgTable("initiatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  objectiveId: uuid("objective_id")
    .notNull()
    .references(() => objectives.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: strategyStatusEnum("status").notNull().default("active"),
  priority: priorityEnum("priority").notNull().default("medium"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  initiativeId: uuid("initiative_id")
    .notNull()
    .references(() => initiatives.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: strategyStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: taskStatusEnum("status").notNull().default("active"),
  latestUpdate: text("latest_update"),
  nextAction: text("next_action"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// raw_body is retained only long enough for the interpretation pipeline to run
// against it; a retention job (out of scope for this slice) should purge it after
// suggestions are generated. Ingestion must strip patient identifiers before a row
// ever lands here.
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: sourceTypeEnum("type").notNull(),
    externalId: text("external_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    rawBody: text("raw_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("sources_org_external_id_unique").on(table.organizationId, table.externalId)],
);

export const suggestions = pgTable("suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  targetType: targetTypeEnum("target_type").notNull(),
  // null when this suggestion proposes creating a new row of targetType
  targetId: uuid("target_id"),
  changeType: changeTypeEnum("change_type").notNull(),
  proposedDiff: jsonb("proposed_diff").notNull(),
  reasoning: text("reasoning").notNull(),
  confidence: real("confidence").notNull(),
  status: suggestionStatusEnum("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Decisions that need a human call -- distinct from suggestions (which propose
// changes to the Objective/Initiative/Project/Task tree) and from a task's status:
// a decision has a decider (who is on the hook to decide, often someone outside
// the app entirely -- a board member, investor, advisor) and stakeholders (who
// needs to be consulted/informed), tracked until resolved.
export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  // Three separate narrative fields instead of one description blob, so a
  // decision card can render "why it matters / relevant context / suggested
  // next step" as distinct, scannable sections. A human filling this in by
  // hand need not fill in all three.
  whyItMatters: text("why_it_matters"),
  relevantContext: text("relevant_context"),
  suggestedNextStep: text("suggested_next_step"),
  // Free text, not a users FK: decision-makers here are often external (board
  // members, advisors, investors) who aren't app users.
  decider: text("decider").notNull(),
  stakeholders: text("stakeholders").array().notNull().default([]),
  status: decisionStatusEnum("status").notNull().default("open"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  resolution: text("resolution"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  // The specific task this decision arose from, if any -- broader objective
  // context is reachable by walking task -> project -> initiative -> objective
  // if ever needed, not looked up here.
  relatedTaskId: uuid("related_task_id").references(() => tasks.id),
  // Optional citation back to the source (email/transcript) this decision came
  // from, mirroring suggestions.sourceId.
  sourceId: uuid("source_id").references(() => sources.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only: rows are never updated or deleted by application code.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  objectives: many(objectives),
  authorizedUsers: many(authorizedUsers),
}));

export const authorizedUsersRelations = relations(authorizedUsers, ({ one }) => ({
  organization: one(organizations, { fields: [authorizedUsers.organizationId], references: [organizations.id] }),
  invitedByUser: one(users, { fields: [authorizedUsers.invitedBy], references: [users.id] }),
}));

export const objectivesRelations = relations(objectives, ({ many }) => ({
  initiatives: many(initiatives),
}));

export const initiativesRelations = relations(initiatives, ({ one, many }) => ({
  objective: one(objectives, { fields: [initiatives.objectiveId], references: [objectives.id] }),
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  initiative: one(initiatives, { fields: [projects.initiativeId], references: [initiatives.id] }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
}));

export const sourcesRelations = relations(sources, ({ many }) => ({
  suggestions: many(suggestions),
}));

export const suggestionsRelations = relations(suggestions, ({ one }) => ({
  source: one(sources, { fields: [suggestions.sourceId], references: [sources.id] }),
  reviewer: one(users, { fields: [suggestions.reviewedBy], references: [users.id] }),
}));

export const decisionsRelations = relations(decisions, ({ one }) => ({
  organization: one(organizations, { fields: [decisions.organizationId], references: [organizations.id] }),
  relatedTask: one(tasks, { fields: [decisions.relatedTaskId], references: [tasks.id] }),
  source: one(sources, { fields: [decisions.sourceId], references: [sources.id] }),
}));
