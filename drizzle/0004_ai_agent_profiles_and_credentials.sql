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
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_credentials_profile_id_priority_index" ON "agent_credentials" USING btree ("profile_id","priority");--> statement-breakpoint
CREATE INDEX "agent_credentials_active_priority_idx" ON "agent_credentials" USING btree ("profile_id","priority") WHERE "agent_credentials"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_profile_id_label_index" ON "agent_credentials" USING btree ("profile_id","label");--> statement-breakpoint
CREATE INDEX "agent_profiles_is_active_priority_index" ON "agent_profiles" USING btree ("is_active","priority");