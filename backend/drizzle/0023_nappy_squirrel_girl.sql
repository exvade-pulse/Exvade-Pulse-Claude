CREATE TYPE "public"."question_link_type" AS ENUM('decision', 'task', 'project');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('open', 'resolved');--> statement-breakpoint
ALTER TYPE "public"."change_type" ADD VALUE 'question';--> statement-breakpoint
ALTER TYPE "public"."target_type" ADD VALUE 'question';--> statement-breakpoint
CREATE TABLE "strategic_question_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"entity_type" "question_link_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "strategic_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"objective_id" uuid NOT NULL,
	"title" text NOT NULL,
	"hypothesis" text,
	"status" "question_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"owner" text,
	"converted_from_decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategic_question_links" ADD CONSTRAINT "strategic_question_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategic_question_links" ADD CONSTRAINT "strategic_question_links_question_id_strategic_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."strategic_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategic_question_links" ADD CONSTRAINT "strategic_question_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategic_questions" ADD CONSTRAINT "strategic_questions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategic_questions" ADD CONSTRAINT "strategic_questions_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategic_questions" ADD CONSTRAINT "strategic_questions_converted_from_decision_id_decisions_id_fk" FOREIGN KEY ("converted_from_decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategic_question_links_unique" ON "strategic_question_links" USING btree ("question_id","entity_type","entity_id");