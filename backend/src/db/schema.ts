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
