ALTER TYPE "public"."strategy_status" ADD VALUE 'superseded';--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_superseded_by_id_initiatives_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."initiatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_superseded_by_id_objectives_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."objectives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_superseded_by_id_projects_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;