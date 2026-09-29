ALTER TYPE "public"."decision_status" ADD VALUE 'pending_info';--> statement-breakpoint
ALTER TYPE "public"."decision_status" ADD VALUE 'action_in_progress';--> statement-breakpoint
ALTER TYPE "public"."decision_status" ADD VALUE 'closed';--> statement-breakpoint
ALTER TYPE "public"."decision_status" ADD VALUE 'superseded';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "executive_review_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "executive_review_snapshots" ADD CONSTRAINT "executive_review_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executive_review_snapshots" ADD CONSTRAINT "executive_review_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_superseded_by_id_decisions_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_superseded_by_id_tasks_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;