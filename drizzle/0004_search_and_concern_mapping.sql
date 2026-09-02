CREATE TYPE "public"."search_source" AS ENUM('app', 'mcp', 'whatsapp');--> statement-breakpoint
CREATE TABLE "search_rate_limits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"patient_id" uuid,
	"source" "search_source" DEFAULT 'app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_queries" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "search_queries" ADD COLUMN "source" "search_source" DEFAULT 'app' NOT NULL;--> statement-breakpoint
CREATE INDEX "search_rate_limits_patient_id_created_at_index" ON "search_rate_limits" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "search_rate_limits_source_created_at_index" ON "search_rate_limits" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "search_rate_limits_created_at_index" ON "search_rate_limits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "search_queries_result_count_created_at_index" ON "search_queries" USING btree ("result_count","created_at");