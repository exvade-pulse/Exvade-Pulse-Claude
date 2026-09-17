CREATE TYPE "public"."visibility" AS ENUM('team', 'leadership', 'restricted');--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "visibility" "visibility" DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "visibility" "visibility" DEFAULT 'team' NOT NULL;