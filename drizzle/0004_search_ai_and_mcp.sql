CREATE TYPE "public"."search_source" AS ENUM('app', 'mcp', 'whatsapp');--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"label" varchar(120) NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_last4" varchar(4) NOT NULL,
	"priority" smallint DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_failure_kind" varchar(40),
	"cooldown_until" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"provider" varchar(40) NOT NULL,
	"model" varchar(120) NOT NULL,
	"base_url" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" smallint DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "mcp_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"hashed_key" text NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"key_last4" varchar(4) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_clients_name_unique" UNIQUE("name"),
	CONSTRAINT "mcp_clients_key_prefix_unique" UNIQUE("key_prefix")
);
--> statement-breakpoint
CREATE TABLE "mcp_request_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mcp_client_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_rate_limits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"patient_id" uuid,
	"source" "search_source" DEFAULT 'app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_queries" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "search_queries" ADD COLUMN "source" "search_source" DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_credentials_profile_id_priority_index" ON "agent_credentials" USING btree ("profile_id","priority");--> statement-breakpoint
CREATE INDEX "agent_credentials_active_priority_idx" ON "agent_credentials" USING btree ("profile_id","priority") WHERE "agent_credentials"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_profile_id_label_index" ON "agent_credentials" USING btree ("profile_id","label");--> statement-breakpoint
CREATE INDEX "agent_profiles_is_active_priority_index" ON "agent_profiles" USING btree ("is_active","priority");--> statement-breakpoint
CREATE INDEX "mcp_clients_is_active_index" ON "mcp_clients" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "mcp_request_attempts_mcp_client_id_created_at_index" ON "mcp_request_attempts" USING btree ("mcp_client_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_request_attempts_created_at_index" ON "mcp_request_attempts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "search_rate_limits_patient_id_created_at_index" ON "search_rate_limits" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "search_rate_limits_source_created_at_index" ON "search_rate_limits" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "search_rate_limits_created_at_index" ON "search_rate_limits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "search_queries_result_count_created_at_index" ON "search_queries" USING btree ("result_count","created_at");