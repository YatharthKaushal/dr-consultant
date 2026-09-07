CREATE TYPE "public"."deletable_account_type" AS ENUM('patient', 'doctor');--> statement-breakpoint
ALTER TYPE "public"."deletion_status" ADD VALUE 'cancelled' BEFORE 'executed';--> statement-breakpoint
CREATE TABLE "deleted_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_type" "deletable_account_type" NOT NULL,
	"account_id" uuid NOT NULL,
	"deletion_request_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"original_mobile_number" varchar(16) NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by_admin_id" uuid,
	"restored_at" timestamp with time zone,
	"restored_by_admin_id" uuid
);
--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ALTER COLUMN "patient_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD COLUMN "doctor_id" uuid;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deleted_accounts" ADD CONSTRAINT "deleted_accounts_deletion_request_id_data_deletion_requests_id_fk" FOREIGN KEY ("deletion_request_id") REFERENCES "public"."data_deletion_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_accounts" ADD CONSTRAINT "deleted_accounts_deleted_by_admin_id_admins_id_fk" FOREIGN KEY ("deleted_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_accounts" ADD CONSTRAINT "deleted_accounts_restored_by_admin_id_admins_id_fk" FOREIGN KEY ("restored_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deleted_accounts_account_type_account_id_index" ON "deleted_accounts" USING btree ("account_type","account_id");--> statement-breakpoint
CREATE INDEX "deleted_accounts_deletion_request_id_index" ON "deleted_accounts" USING btree ("deletion_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deleted_accounts_live_account_idx" ON "deleted_accounts" USING btree ("account_type","account_id") WHERE "deleted_accounts"."restored_at" is null;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_deletion_requests_doctor_id_index" ON "data_deletion_requests" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "data_deletion_requests_scheduled_for_status_index" ON "data_deletion_requests" USING btree ("scheduled_for","status");--> statement-breakpoint
CREATE UNIQUE INDEX "data_deletion_requests_open_patient_idx" ON "data_deletion_requests" USING btree ("patient_id") WHERE "data_deletion_requests"."status" IN ('requested','in_review','approved');--> statement-breakpoint
CREATE UNIQUE INDEX "data_deletion_requests_open_doctor_idx" ON "data_deletion_requests" USING btree ("doctor_id") WHERE "data_deletion_requests"."status" IN ('requested','in_review','approved');--> statement-breakpoint
CREATE INDEX "doctors_deleted_at_index" ON "doctors" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "patients_deleted_at_index" ON "patients" USING btree ("deleted_at");--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_account_xor_check" CHECK (("data_deletion_requests"."patient_id" is not null) <> ("data_deletion_requests"."doctor_id" is not null));