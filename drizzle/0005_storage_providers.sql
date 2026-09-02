CREATE TABLE "storage_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" smallint DEFAULT 100 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_failure_kind" varchar(40),
	"cooldown_until" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_providers_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE INDEX "storage_providers_is_active_priority_index" ON "storage_providers" USING btree ("is_active","priority");