CREATE TYPE "public"."integration_type" AS ENUM('circleback');--> statement-breakpoint
CREATE TABLE "webhook_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "integration_type" NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webhook_integrations" ADD CONSTRAINT "webhook_integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_integrations_org_type_unique" ON "webhook_integrations" USING btree ("organization_id","type");