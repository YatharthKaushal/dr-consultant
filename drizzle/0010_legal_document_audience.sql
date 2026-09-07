CREATE TYPE "public"."content_format" AS ENUM('markdown', 'plain_text');--> statement-breakpoint
CREATE TYPE "public"."legal_audience" AS ENUM('all', 'patient', 'doctor');--> statement-breakpoint
DROP INDEX "legal_documents_document_type_version_index";--> statement-breakpoint
DROP INDEX "legal_documents_document_type_is_current_index";--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "audience" "legal_audience" DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "content_format" "content_format" DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_documents_document_type_audience_version_index" ON "legal_documents" USING btree ("document_type","audience","version");--> statement-breakpoint
CREATE INDEX "legal_documents_document_type_audience_is_current_index" ON "legal_documents" USING btree ("document_type","audience","is_current");