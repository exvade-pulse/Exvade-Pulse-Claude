CREATE TYPE "public"."entity_node_type" AS ENUM('objective', 'initiative', 'project', 'task', 'decision', 'company_entity');--> statement-breakpoint
CREATE TYPE "public"."relation_type" AS ENUM('depends_on', 'blocks', 'informs', 'affects', 'part_of', 'funded_by', 'performed_by', 'awaiting_response_from', 'coupled_with', 'constrains');--> statement-breakpoint
CREATE TABLE "company_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_type" "entity_node_type" NOT NULL,
	"from_id" uuid NOT NULL,
	"to_type" "entity_node_type" NOT NULL,
	"to_id" uuid NOT NULL,
	"relation_type" "relation_type" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_entities" ADD CONSTRAINT "company_entities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;