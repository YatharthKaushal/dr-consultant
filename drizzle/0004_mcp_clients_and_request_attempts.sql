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
CREATE INDEX "mcp_clients_is_active_index" ON "mcp_clients" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "mcp_request_attempts_mcp_client_id_created_at_index" ON "mcp_request_attempts" USING btree ("mcp_client_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_request_attempts_created_at_index" ON "mcp_request_attempts" USING btree ("created_at");