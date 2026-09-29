CREATE TYPE "public"."date_type" AS ENUM('confirmed', 'planned', 'estimated');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_date_type" date_type;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_label" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "waiting_for" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "follow_up_on" timestamp with time zone;