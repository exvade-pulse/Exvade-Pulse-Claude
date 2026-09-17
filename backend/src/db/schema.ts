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

export const sourceTypeEnum = pgEnum("source_type", ["gmail", "circleback", "document", "manual"]);
export type SourceType = (typeof sourceTypeEnum.enumValues)[number];

export const targetTypeEnum = pgEnum("target_type", [
  "objective",
  "initiative",
  "project",
  "task",
  "decision",
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

// Kept distinct from sourceTypeEnum: a webhook integration is a configured
// credential (one per org per type), while source_type also covers ingestion
// paths (like gmail) that may never get a webhook_integrations row at all.
// "email" rather than "postmark": no inbound-email provider is actually
// connected yet (Postmark is just the concrete shape this slice targets, see
// emailPayload.ts), and naming the enum value after the category rather than
// today's guessed provider means swapping providers later doesn't require a
// migration, matching how this app already avoids baking in assumptions that
// would make adding a second source a rewrite.
export const integrationTypeEnum = pgEnum("integration_type", ["circleback", "email"]);
export type IntegrationType = (typeof integrationTypeEnum.enumValues)[number];

// Every kind of node a relationship can point at -- the four hierarchy
// levels, decisions, and company_entity (an external org/person tracked only
// for its relationships, see companyEntities below). Deliberately the same
// closed set on both ends of a relationship rather than a free-text type, so
// a relationship can always be resolved back to a real row without guessing
// which table to query.
export const entityNodeTypeEnum = pgEnum("entity_node_type", [
  "objective",
  "initiative",
  "project",
  "task",
  "decision",
  "company_entity",
]);
export type EntityNodeType = (typeof entityNodeTypeEnum.enumValues)[number];

// Access boundary for a task/decision. "team" (the default) is visible to
// every authenticated member of the org; "leadership" and "restricted" are
// both visible to admins only -- this app has exactly two roles today
// (member/admin, see userRoleEnum), so a third distinct enforcement tier for
// "restricted" would have to mean something invented (e.g. a per-item
// allowlist of specific viewers) that doesn't exist anywhere else in this
// schema. Kept as three named levels anyway, matching the vocabulary a real
// reviewer would use, rather than collapsing to a boolean -- if a genuine
// third access tier is ever needed, "restricted" is already the natural
// place to layer stricter enforcement in without a rename.
export const visibilityEnum = pgEnum("visibility", ["team", "leadership", "restricted"]);
export type Visibility = (typeof visibilityEnum.enumValues)[number];

export const relationTypeEnum = pgEnum("relation_type", [
  "depends_on",
  "blocks",
  "informs",
  "affects",
  "part_of",
  "funded_by",
  "performed_by",
  "awaiting_response_from",
  "coupled_with",
  "constrains",
]);
export type RelationType = (typeof relationTypeEnum.enumValues)[number];

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
  // Per-user, not per-org: the Activity page's "what changed since your last
  // visit" is deliberately scoped to each viewer's own last look, so two
  // users in the same org watching the same audit_log see different "new
  // since" windows. Null until their first-ever visit.
  lastActivityViewAt: timestamp("last_activity_view_at", { withTimezone: true }),
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

// owner is a single free-text "who's responsible" field, not a stakeholders
// array like decisions have -- decisions genuinely need decider+stakeholders
// (a decider who must choose, plus others to consult/inform), but these four
// levels just need the reference app's proven "Owner: Name" pattern. A full
// stakeholders array here would be real added UI scope (managing a list at
// four levels) with no evidence yet that it's needed; add it later if it is.
export const objectives = pgTable("objectives", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: strategyStatusEnum("status").notNull().default("active"),
  priority: priorityEnum("priority").notNull().default("medium"),
  owner: text("owner"),
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
  owner: text("owner"),
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
  owner: text("owner"),
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
  owner: text("owner"),
  // Deliberately not in suggestions/apply.ts's ALLOWED_FIELDS -- AI
  // processing must never be the thing that widens (or narrows) who can see
  // a task, only a human admin can, via a dedicated endpoint.
  visibility: visibilityEnum("visibility").notNull().default("team"),
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

// One row per (organizationId, type): rotating a token updates this row in
// place rather than creating a new one, so a stale row never lingers as a
// second valid credential. Only tokenHash is stored -- the raw token is
// returned once, at generation time, and never persisted or retrievable again.
export const webhookIntegrations = pgTable(
  "webhook_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: integrationTypeEnum("type").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("webhook_integrations_org_type_unique").on(table.organizationId, table.type)],
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
  // Same visibilityEnum as tasks.visibility -- see its comment. Not in
  // ALLOWED_FIELDS.decision either, for the same reason.
  visibility: visibilityEnum("visibility").notNull().default("team"),
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

// External orgs/people worth tracking for their relationships to real work
// (Duke, FDA, NIH, a vendor, a named collaborator) -- not part of the
// Objective/Initiative/Project/Task hierarchy itself, and not a company
// "user" (they have no login). `kind` is deliberately free text, not an
// enum: a real-world entity often doesn't sort cleanly into one bucket (Duke
// is a clinical trial site, a university, and informally a "collaborator"
// all at once), so forcing a fixed category would misrepresent more entities
// than it would usefully classify.
export const companyEntities = pgTable("company_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A typed, directed edge between any two nodes in the Company Map --
// Objective/Initiative/Project/Task/Decision/CompanyEntity on either end
// (see entityNodeTypeEnum). fromId/toId are deliberately plain uuids with no
// FK constraint, the same pattern suggestions.targetId already uses, since a
// single column can't carry a foreign key to six different tables depending
// on the sibling type column -- existence and org-scoping are validated in
// application code instead (see relationships/manage.ts). Human-curated, not
// AI-proposed: createdBy is required, and nothing in the interpretation
// pipeline writes here.
export const entityRelationships = pgTable("entity_relationships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  fromType: entityNodeTypeEnum("from_type").notNull(),
  fromId: uuid("from_id").notNull(),
  toType: entityNodeTypeEnum("to_type").notNull(),
  toId: uuid("to_id").notNull(),
  relationType: relationTypeEnum("relation_type").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
});

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  objectives: many(objectives),
  authorizedUsers: many(authorizedUsers),
  webhookIntegrations: many(webhookIntegrations),
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
