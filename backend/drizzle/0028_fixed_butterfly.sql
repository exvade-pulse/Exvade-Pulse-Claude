CREATE TYPE "public"."milestone_confidence" AS ENUM('committed', 'forecast', 'unconfirmed');--> statement-breakpoint
CREATE TYPE "public"."milestone_link_type" AS ENUM('task', 'decision', 'project');--> statement-breakpoint
CREATE TYPE "public"."milestone_state" AS ENUM('planned', 'achieved', 'missed', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."objective_health" AS ENUM('on_track', 'at_risk', 'blocked', 'not_assessed');--> statement-breakpoint
CREATE TYPE "public"."risk_escalation" AS ENUM('watching', 'decision_needed');--> statement-breakpoint
CREATE TYPE "public"."risk_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "milestone_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"entity_type" "milestone_link_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"objective_id" uuid NOT NULL,
	"title" text NOT NULL,
	"success_criteria" text,
	"owner" text,
	"baseline_date" timestamp with time zone,
	"forecast_date" timestamp with time zone,
	"actual_date" timestamp with time zone,
	"confidence" "milestone_confidence" DEFAULT 'unconfirmed' NOT NULL,
	"state" "milestone_state" DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "objective_health_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"objective_id" uuid NOT NULL,
	"health" "objective_health" NOT NULL,
	"rationale" text,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assessed_by" text,
	"source" text DEFAULT 'person' NOT NULL,
	"override_reason" text,
	"review_by" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reporting_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"narrative" text,
	"summary" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid
);
--> statement-breakpoint
CREATE TABLE "risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"objective_id" uuid NOT NULL,
	"milestone_id" uuid,
	"title" text NOT NULL,
	"impact" text,
	"likelihood" text,
	"mitigation" text,
	"owner" text,
	"next_review_at" timestamp with time zone,
	"escalation" "risk_escalation" DEFAULT 'watching' NOT NULL,
	"status" "risk_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "objective_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "recommendation" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "impact_of_delay" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "rationale" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "health" "objective_health" DEFAULT 'not_assessed' NOT NULL;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "health_rationale" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "health_assessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "health_assessed_by" text;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "display_order" integer;--> statement-breakpoint
ALTER TABLE "milestone_links" ADD CONSTRAINT "milestone_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_links" ADD CONSTRAINT "milestone_links_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_health_history" ADD CONSTRAINT "objective_health_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_health_history" ADD CONSTRAINT "objective_health_history_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporting_snapshots" ADD CONSTRAINT "reporting_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporting_snapshots" ADD CONSTRAINT "reporting_snapshots_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_links_unique" ON "milestone_links" USING btree ("milestone_id","entity_type","entity_id");--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE set null ON UPDATE no action;